import {
  type Target,
  isReadonly,
  isShallow,
  reactive,
  reactiveMap,
  readonly,
  readonlyMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  toRaw,
} from './reactive'
import { arrayInstrumentations } from './arrayInstrumentations'
import { ReactiveFlags, TrackOpTypes, TriggerOpTypes } from './constants'
import { ITERATE_KEY, track, trigger } from './dep'
import {
  hasChanged,
  hasOwn,
  isArray,
  isIntegerKey,
  isObject,
  isSymbol,
  makeMap,
} from '@vue/shared'
import { isRef } from './ref'
import { warn } from './warning'

const isNonTrackableKeys = /*@__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  /*@__PURE__*/
  Object.getOwnPropertyNames(Symbol)
    // ios10.x Object.getOwnPropertyNames(Symbol) can enumerate 'arguments' and 'caller'
    // but accessing them on Symbol leads to TypeError because Symbol is a strict mode
    // function
    .filter(key => key !== 'arguments' && key !== 'caller')
    .map(key => Symbol[key as keyof SymbolConstructor])
    .filter(isSymbol),
)

function hasOwnProperty(this: object, key: unknown) {
  // #10455 hasOwnProperty may be called with non-string values
  if (!isSymbol(key)) key = String(key)
  const obj = toRaw(this)
  track(obj, TrackOpTypes.HAS, key)
  return obj.hasOwnProperty(key as string)
}

// 拦截属性读取
class BaseReactiveHandler implements ProxyHandler<Target> {
  constructor(
    protected readonly _isReadonly = false, // 是否只读模式
    protected readonly _isShallow = false, // 是否浅层响应式
  ) {}

  get(target: Target, key: string | symbol, receiver: object): any {
    // ------ 1. 处理 SKIP 标记（开发者主动跳过响应式）------
    if (key === ReactiveFlags.SKIP) return target[ReactiveFlags.SKIP]

    const isReadonly = this._isReadonly,
      isShallow = this._isShallow
    // ------ 2. 处理内置标记属性 ------
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly // 判断是否为可变响应式对象
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly // 判断是否为只读对象
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      return isShallow  // 判断是否为浅层代理
    } else if (key === ReactiveFlags.RAW) { // 获取原始对象
      // 判断 receiver 是否是当前代理对象（避免原型链干扰）
      if (
        receiver ===
          (isReadonly
            ? isShallow
              ? shallowReadonlyMap
              : readonlyMap
            : isShallow
              ? shallowReactiveMap
              : reactiveMap
          ).get(target) ||
        // receiver is not the reactive proxy, but has the same prototype
        // this means the receiver is a user proxy of the reactive proxy
        // 处理用户自定义代理包裹响应式对象的情况
        // receiver 不是响应式代理，但是原型上有，说明是用户自己代理包装响应式对象
        Object.getPrototypeOf(target) === Object.getPrototypeOf(receiver)
      ) {
        return target // 返回未被代理的原始对象
      }
      // early return undefined
      // 否则返回 undefined
      return
    }

    // ------ 3. 处理数组方法重写（非只读模式）------
    const targetIsArray = isArray(target)

    if (!isReadonly) {
      let fn: Function | undefined
      // 重写数组方法（如 push/pop 等）
      if (targetIsArray && (fn = arrayInstrumentations[key])) {
        return fn// 返回重写后的方法
      }
      // 处理 hasOwnProperty 调用
      if (key === 'hasOwnProperty') {
        return hasOwnProperty
      }
    }

    // ------ 4. 获取原始值 ------
    const res = Reflect.get(
      target,
      key,
      // if this is a proxy wrapping a ref, return methods using the raw ref
      // as receiver so that we don't have to call `toRaw` on the ref in all
      // its class methods
      // 若 target 是 Ref 包装的对象，直接使用原始 Ref 作为 receiver
      isRef(target) ? target : receiver,
    )

    // ------ 5. 跳过内置 Symbol 或不可追踪键 ------
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res // 如 Symbol.iterator 等不触发依赖收集
    }

    // ------ 6. 依赖收集（仅可变模式）------
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key) // 核心依赖追踪
    }

    // ------ 7. 浅层模式直接返回值 ------
    if (isShallow) {
      return res // 不进行嵌套代理
    }

    // ------ 8. 自动解包 Ref ------
    if (isRef(res)) {
      // ref unwrapping - skip unwrap for Array + integer key.
      // 数组 + 数字索引不自动解包（保持索引与元素位置一致）
      return targetIsArray && isIntegerKey(key) ? res : res.value
    }

    // ------ 9. 深度代理嵌套对象 ------
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      // 根据模式选择代理方式（避免循环依赖）
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

class MutableReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow = false) {
    super(false, isShallow) // 明确标记为非只读
  }

  // ------ 1. set 拦截器（核心更新逻辑）------
  set(
    target: Record<string | symbol, unknown>,
    key: string | symbol,
    value: unknown,
    receiver: object,
  ): boolean {
    let oldValue = target[key]
    // ------ 深度模式处理 ------
    if (!this._isShallow) {
      // 解包旧值（如果是只读 Ref 则不可修改）
      const isOldValueReadonly = isReadonly(oldValue)
      if (!isShallow(value) && !isReadonly(value)) {
        // 确保设置的是原始值（而非代理对象）
        oldValue = toRaw(oldValue)
        value = toRaw(value)
      }
      // Ref 特殊处理：直接修改 .value（非数组且新值不是 Ref）
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        if (isOldValueReadonly) {
          return false // 只读 Ref 拒绝修改
        } else {
          oldValue.value = value // 修改 Ref 内部值
          return true
        }
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    // ------ 判断是否为新增属性 ------
    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)

    // ------ 执行原生设置操作 ------
    const result = Reflect.set(
      target,
      key,
      value,
      isRef(target) ? target : receiver,
    )
    // don't trigger if target is something up in the prototype chain of original
    // ------ 触发更新（确保操作的是原始对象）------
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }

  // ------ 2. deleteProperty 拦截器 ------
  deleteProperty(
    target: Record<string | symbol, unknown>,
    key: string | symbol,
  ): boolean {
    const hadKey = hasOwn(target, key)
    const oldValue = target[key]
    const result = Reflect.deleteProperty(target, key)
    if (result && hadKey) {
      trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
    }
    return result
  }

  // ------ 3. has 拦截器 ------
  has(target: Record<string | symbol, unknown>, key: string | symbol): boolean {
    const result = Reflect.has(target, key)
    if (!isSymbol(key) || !builtInSymbols.has(key)) {
      track(target, TrackOpTypes.HAS, key)
    }
    return result
  }

  // ------ 4. ownKeys 拦截器 ------
  ownKeys(target: Record<string | symbol, unknown>): (string | symbol)[] {
    track(
      target,
      TrackOpTypes.ITERATE,
      isArray(target) ? 'length' : ITERATE_KEY,
    )
    return Reflect.ownKeys(target)
  }
}

// ! 只读对象的处理器（readonly/shallowReadonly）
class ReadonlyReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow = false) {
    super(true, isShallow) // 强制标记为只读
  }

  // ------ 1. 禁止写入 ------
  set(target: object, key: string | symbol) {
    // 禁止写入
    if (__DEV__) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true // 返回 true 但实际不执行操作
  }

  // ------ 2. 禁止删除 ------
  deleteProperty(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }
}

export const mutableHandlers: ProxyHandler<object> =
  /*@__PURE__*/ new MutableReactiveHandler()

export const readonlyHandlers: ProxyHandler<object> =
  /*@__PURE__*/ new ReadonlyReactiveHandler()

export const shallowReactiveHandlers: MutableReactiveHandler =
  /*@__PURE__*/ new MutableReactiveHandler(true)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers: ReadonlyReactiveHandler =
  /*@__PURE__*/ new ReadonlyReactiveHandler(true)
