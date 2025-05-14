## 1 reactive 的底层逻辑是什么，具体是如何实现的

> 本篇文章 vue3 的版本为 3.5.13 ，ref 源码地址 `core\packages\reactivity\src\reactive.ts`

### 1.1 reactive 函数：reative 的调用

```js
export function reactive(target: object) {
  // 只读代理，直接返回
  if (isReadonly(target)) {
    return target;
  }
  return createReactiveObject(
    target,
    false,
    mutableHandlers, // 普通对象/数组的可变处理器
    mutableCollectionHandlers, // 集合类型的可变处理器
    reactiveMap
  );
}
```

### 1.2 createReactiveObject 函数：reactive 的底层逻辑

```js
/**
 * @description:
 * @param target - 源对象
 * @param isReadonly - 是否只读
 * @param baseHandlers - 基本对象类型的 handlers， 处理数组，对象.
 * @param collectionHandlers - 集合对象类型的handlers，处理set、map、weakSet、weakMap.
 * @param proxyMap - WeakMap数据结构存储副作用函数.
 * @return {*}
 */
function createReactiveObject(
  target: Target,
  isReadonly: boolean,
  baseHandlers: ProxyHandler<any>,
  collectionHandlers: ProxyHandler<any>,
  proxyMap: WeakMap<Target, any>
) {
  // 不是对象类型返回目标，并且在开发模式下抛出错误提醒
  if (!isObject(target)) {
    if (__DEV__) {
      warn(`value cannot be made ${isReadonly ? "readonly" : "reactive"}: ${String(target)}`);
    }
    return target;
  }

  // 避免重复代理
  // target[ReactiveFlags.RAW] 指向原始未被代理的对象。检测到该属性，说明已经经过代理的响应式对象。
  // 特例：对响应式对象创建只读代理，允许创建新的只读代理
  if (target[ReactiveFlags.RAW] && !(isReadonly && target[ReactiveFlags.IS_REACTIVE])) {
    return target;
  }

  // 检查是否可以代理，不可代理直接返回
  const targetType = getTargetType(target);
  if (targetType === TargetType.INVALID) {
    return target;
  }

  // 尝试直接从缓存直接拿取代理对象
  const existingProxy = proxyMap.get(target);
  if (existingProxy) {
    return existingProxy;
  }

  // 创建新的proxy并缓存
  // 利用 Proxy 创建响应式对象，对象或数组类型使用 baseHandlers，Set/Map/WeakSet/WeakMap类型collectionHandlers
  const proxy = new Proxy(target, targetType === TargetType.COLLECTION ? collectionHandlers : baseHandlers);
  proxyMap.set(target, proxy);
  return proxy;
}
```

### 1.3 handler 函数：处理不同类型的 proxy 代理

#### 1.3.1 处理不同类型的 handler

```js
// baseHandlers: 处理普通对象/数组的 Proxy 陷阱（如 get, set）
import {
  mutableHandlers, // reactive 函数
  readonlyHandlers, // readonly  函数
  shallowReactiveHandlers, // shallowReactive  函数
  shallowReadonlyHandlers // shallowReadonly  函数
} from "./baseHandlers";

// collectionHandlers: 处理集合类型（Map, Set 等）的 Proxy 陷阱
import {
  mutableCollectionHandlers,
  readonlyCollectionHandlers,
  shallowCollectionHandlers,
  shallowReadonlyCollectionHandlers
} from "./collectionHandlers";
```

#### 1.3.2 处理普通对象和数组的处理器 baseHandlers

> 源码地址 `packages/reactivity/src/baseHandlers.ts`

属性读取流程（get）

1. 检查 ReactiveFlags → 是 → 返回对应标记
2. 检查数组方法 → 是 → 返回重写方法
3. 反射获取值
4. 非只读模式 → 触发 track 收集依赖
5. 浅层模式 → 直接返回值
6. 深度模式 → 递归代理对象
7. Ref 值 → 自动解包（数组索引除外）

属性写入流程（set）

1. 获取旧值
2. 深度模式 → 解包 Ref/原始值
3. 检查是否为新增属性
4. 反射执行设置
5. 触发 trigger 通知更新
   - ADD → 新增属性
   - SET → 值变化

```js
// 可变对象的处理器（reactive/shallowReactive）
export const mutableHandlers: ProxyHandler<object> = {
  get: createGetter(), // 拦截属性读取
  set: createSetter(), // 拦截属性设置
  deleteProperty, // 拦截 delete 操作
  has, // 拦截 in 操作符
  ownKeys // 拦截 Object.keys 等操作
};
```

包装类

```js
// 拦截属性读取
class BaseReactiveHandler implements ProxyHandler<Target> {
  constructor(
    protected readonly _isReadonly = false, // 是否只读模式
    protected readonly _isShallow = false, // 是否浅层响应式
  ) {}

  // ! 拦截属性读取
  get(target: Target, key: string | symbol, receiver: object): any {
    // ------ 1. 处理 SKIP 标记（开发者主动跳过响应式）------
    if (key === ReactiveFlags.SKIP) return target[ReactiveFlags.SKIP]

    const isReadonly = this._isReadonly, isShallow = this._isShallow

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
        return hasOwnProperty // 使用优化后的 hasOwn 实现
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
```

#### 1.3.3 处理集合类型的处理器 collectionHandlers

> 源码地址 `packages/reactivity/src/collectionHandlers.ts`

#### 1.3.4 只读对象的处理器

```js
// ! 只读对象的处理器（readonly/shallowReadonly）
export const readonlyHandlers: ProxyHandler<object> = {
  get: createGetter(true), // 只读版本的 get
  set(target, key) {
    // 禁止写入
    if (__DEV__) warn(`Set operation on key "${String(key)}" failed: target is readonly.`, target);
    return true;
  },
  deleteProperty(target, key) {
    // 禁止删除
    if (__DEV__) warn(`Delete operation on key "${String(key)}" failed: target is readonly.`, target);
    return true;
  }
};
```

### 1.4 arrayInstrumentations： 数组方法的重写

| 类型        | 方法列表                                           |
| ----------- | -------------------------------------------------- |
| 遍历方法    | forEach, map, filter, reduce, find, some, every 等 |
| 查找方法    | includes, indexOf, lastIndexOf                     |
| 变异方法    | push, pop, shift, unshift, splice                  |
| ES2023+方法 | toReversed, toSorted, toSpliced                    |
| 迭代器方法  | Symbol.iterator, entries, values                   |

#### 1.4.1 遍历方法

```js
export function shallowReadArray<T>(arr: T[]): T[] {
  track((arr = toRaw(arr)), TrackOpTypes.ITERATE, ARRAY_ITERATE_KEY)
  return arr
}

type ArrayMethods = keyof Array<any> | 'findLast' | 'findLastIndex'
const arrayProto = Array.prototype
/**
 * @description:  数组遍历方法的核心适配器（代码插桩，建立 ARRAY_ITERATE 依赖）
 * @param {*} self: 当前数组实例
 * @param {*} method: 调用的数组方法名
 * @param {*} fn: 回调函数
 * @param {*} thisArg: 回调函数this指向（可选）
 * @param {*} wrappedRetFn: 返回值包装函数（可选）
 * @param {*} args: 原始参数（可选）
 * @return {*}
 */
function apply(
  self: unknown[],
  method: ArrayMethods,
  fn: (item: unknown, index: number, array: unknown[]) => unknown,
  thisArg?: unknown,
  wrappedRetFn?: (result: any) => unknown,
  args?: IArguments,
) {
  // 触发 ARRAY_ITERATE 依赖追踪
  const arr = shallowReadArray(self)
  // 是否需要深度包装返回值
  const needsWrap = arr !== self && !isShallow(self)
  // @ts-expect-error our code is limited to es2016 but user code is not
  // 获取原生数组方法
  const methodFn = arr[method]

  // #11759
  // If the method being called is from a user-extended Array, the arguments will be unknown
  // (unknown order and unknown parameter types). In this case, we skip the shallowReadArray
  // handling and directly call apply with self.

  // 当方法非原生数组方法时（如用户自定义的数组扩展方法）
  if (methodFn !== arrayProto[method as any]) {
    const result = methodFn.apply(self, args)
    return needsWrap ? toReactive(result) : result
  }

  let wrappedFn = fn
  // 当前数组是响应式代理
  if (arr !== self) {
    // 需要深度包装
    if (needsWrap) {
      wrappedFn = function (this: unknown, item, index) {
        // 将 item 转换为响应式对象
        return fn.call(this, toReactive(item), index, self)
      }
    } else if (fn.length > 2) {
      // 处理第三个参数（原始数组）
      wrappedFn = function (this: unknown, item, index) {
        return fn.call(this, item, index, self)
      }
    }
  }

  // 执行原生方法并处理返回值
  const result = methodFn.call(arr, wrappedFn, thisArg)
  return needsWrap && wrappedRetFn ? wrappedRetFn(result) : result
}
```

#### 1.4.2 查找方法

```js
/**
 * @description: 数组查找方法的核心适配器（需判断传入的是原始对象还是响应式代理）
 * @param {*} self: 当前数组实例
 * @param {*} method: 调用的方法名
 * @param {*} args: 方法调用时的参数
 * @return {*}
 */
function searchProxy( self: unknown[], method: keyof Array<any>, args: unknown ) {
  // 获取原始数组
  const arr = toRaw(self) as any
  // 追踪迭代依赖
  track(arr, TrackOpTypes.ITERATE, ARRAY_ITERATE_KEY)
  // we run the method using the original args first (which may be reactive)
  // 第一次查找（使用原始参数）
  const res = arr[method](...args)

  // if that didn't work, run it again using raw values.
  // 查找失败 && 第一个参数是响应式代理
  if ((res === -1 || res === false) && isProxy(args[0])) {
    // 转换第一个参数为原始值
    args[0] = toRaw(args[0])
    // 重新调用方法
    return arr[method](...args)
  }

  return res
}
```

#### 1.4.3 变异方法

#### 1.4.4 迭代器方法

#### 1.4.5 ES2023+ 方法

---

### 1.5 createReactiveObject 函数 所使用到的工具函数

#### 1.5.1 缓存

```js
// WeakMap 缓存：存储已代理的对象，避免重复创建 Proxy（WeakMap 键为弱引用，不影响 GC）
export const reactiveMap: WeakMap<Target, any> = new WeakMap<Target, any>()
export const shallowReactiveMap: WeakMap<Target, any> = new WeakMap<Target,>()
export const readonlyMap: WeakMap<Target, any> = new WeakMap<Target, any>()
export const shallowReadonlyMap: WeakMap<Target, any> = new WeakMap<Target,>()
```

#### 1.5.2 类型标记：getTargetType 函数

```js
enum TargetType {
  INVALID = 0,  // 不可代理类型（如原始值、不可扩展对象）
  COMMON = 1, // 普通对象/数组
  COLLECTION = 2, // 集合类型（Map, Set 等）
}

function targetTypeMap(rawType: string) {
  switch (rawType) {
    case 'Object':
    case 'Array':
      return TargetType.COMMON
    case 'Map':
    case 'Set':
    case 'WeakMap':
    case 'WeakSet':
      return TargetType.COLLECTION
    default:
      return TargetType.INVALID
  }
}

function getTargetType(value: Target) {
  return value[ReactiveFlags.SKIP] || !Object.isExtensible(value)
    ? TargetType.INVALID
    : targetTypeMap(toRawType(value))	// toRawType: 获取对象的原始类型（如 Object, Array）。toRawType 使用 Object.prototype.toString 判断对象的类型
}
```

---

### 1.5 面试回答

创建响应式对象流程：

1. 检查是否为对象 → 否 → 直接返回
2. 检查是否已被代理 → 是 → 直接返回缓存
3. 检查是否可代理 → 否 → 返回原对象
4. 创建 Proxy（选择处理器）
5. 存入缓存 WeakMap
6. 返回代理对象

## 2 ref 底层是否会使用 reactive 处理数据

### 2.1 源码分析

### 2.2 面试回答

## 3 为什么已经有了 reactive 还需要在设计一个 ref 呢？

## 4 为什么 ref 数据必须要有个 value 属性，访问 ref 数据必须要通过.value 的方式呢？
