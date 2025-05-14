## 1 ref 的底层逻辑是什么，具体是如何实现的

> 本篇文章 vue3 的版本为 3.5.13 ，ref 源码地址 `core\packages\reactivity\src\ref.ts`

### 1.1 createRef 函数：ref 的调用

```js
// ref使用，调用createRef函数
export function ref(value?: unknown) {
  return createRef(value, false);
}

// createRef
function createRef(rawValue: unknown, shallow: boolean) {
  // 通过 isRef 判断原始值rawValue是否为 ref对象
  // 如果是 ref对象 ，则直接返回原始值
  if (isRef(rawValue)) {
    return rawValue;
  }
  // 如果不是 ref对象 ，返回 RefImpl包装类
  return new RefImpl(rawValue, shallow);
}
```

### 1.2 isRef 函数：判断原始值是否为 ref 对象

```js
// isRef
export function isRef(r: any): r is Ref {
// isRef的实现，是通过 内部标识位ReactiveFlags 来判断
  return r ? r[ReactiveFlags.IS_REF] === true : false
}

// ReactiveFlags 标识位枚举
export enum ReactiveFlags {
  SKIP = '__v_skip',
  IS_REACTIVE = '__v_isReactive',
  IS_READONLY = '__v_isReadonly',
  IS_SHALLOW = '__v_isShallow',
  RAW = '__v_raw',
  IS_REF = '__v_isRef',
}
```

### 1.3 RefImpl 包装类：ref 的底层逻辑

```js
// RefImpl 包装类
class RefImpl<T = any> {
  _value: T
  private _rawValue: T

	// Dep 类是 Vue 3 响应式系统中用于管理依赖关系的核心组件，
	// 它通过双向链表和版本控制机制，确保依赖项的变化能够准确、高效地通知到所有订阅者。
  dep: Dep = new Dep()

	// 只读属性 IS_REF 内部判断是否为ref对象的标识位
  public readonly [ReactiveFlags.IS_REF] = true
  public readonly [ReactiveFlags.IS_SHALLOW]: boolean = false

  constructor(value: T, isShallow: boolean) {
		// 非浅比较 用 toRaw() 处理为原始值。toRaw源码见 1.4
    this._rawValue = isShallow ? value : toRaw(value)
		// 非浅比较 用 toReactive() 处理为响应式。toReactive源码见 1.4
    this._value = isShallow ? value : toReactive(value)
    this[ReactiveFlags.IS_SHALLOW] = isShallow
  }

	// getter 收集依赖
  get value() {
		// 在开发模式下，调用 dep.track 方法，传递目标对象、操作类型和键值，以跟踪依赖关系。
    if (__DEV__) {
      this.dep.track({
        target: this,
        type: TrackOpTypes.GET,
        key: 'value',
      })
    } else {
			// 在生产模式下，直接调用 dep.track 方法。开启依赖收集
      this.dep.track()
    }
    return this._value
  }

	// setter 触发依赖更新
  set value(newValue) {
    const oldValue = this._rawValue

		// 通过 标识位ReactiveFlags 判断是否直接使用新值
    const useDirectValue =
      this[ReactiveFlags.IS_SHALLOW] ||
      isShallow(newValue) ||
      isReadonly(newValue)

		// 通过 useDirectValue 判断是否直接使用新值 还是解包新值返回原始值
    newValue = useDirectValue ? newValue : toRaw(newValue)

		// 检查新值与旧值是否发生变化。
    if (hasChanged(newValue, oldValue)) {
      this._rawValue = newValue
      this._value = useDirectValue ? newValue : toReactive(newValue)
			// 在开发模式下，调用 dep.trigger 方法，传递目标对象、操作类型、键值、新值和旧值，以触发依赖更新。
      if (__DEV__) {
        this.dep.trigger({
          target: this,
          type: TriggerOpTypes.SET,
          key: 'value',
          newValue,
          oldValue,
        })
      } else {
			// 在生产模式下，直接调用 dep.trigger 方法。触发依赖更新
        this.dep.trigger()
      }
    }
  }
}
```

### 1.4 RefImpl 包装类 所使用到的工具函数

```js
// 转为响应式对象
// 值为对象类型，则使用 Proxy 代理。否则返回原始值
export const toReactive = <T extends unknown>(value: T): T =>
  isObject(value) ? reactive(value) : value

// 解包 vue创建的代理 为 原始对象。
// toRaw() 可以返回由 reactive()、readonly()、shallowReactive() 或者 shallowReadonly() 创建的代理对应的原始对象。
export function toRaw<T>(observed: T): T {
	// 通过判断代理对象的 标识位ReactiveFlags 来判断是否需要解包
  const raw = observed && (observed as Target)[ReactiveFlags.RAW]
	// 递归解包代理对象
  return raw ? toRaw(raw) : observed
}

// 判断是否为只读对象。通过 标识位ReactiveFlags 判断
export function isReadonly(value: unknown): boolean {
  return !!(value && (value as Target)[ReactiveFlags.IS_READONLY])
}

// 判断是否为浅比较。通过 标识位ReactiveFlags 判断
export function isShallow(value: unknown): boolean {
  return !!(value && (value as Target)[ReactiveFlags.IS_SHALLOW])
}

// 判断新旧值是否变更。
export const hasChanged = (value: any, oldValue: any): boolean =>
  !Object.is(value, oldValue)


// 因为这里不讨论具体的响应式实现原理，dep类的track 和 trigger 这里不展开描述

```

### 1.5 面试回答

1. 通过 isRef 判断是否为 ref 对象。是 ref 对象则直接返回，不是 ref 对象则使用 RefImpl 包装类
2. ReactiveFlags.IS_REF 带上标识位，后续可以通过标识位判断代理值是否为 ref 对象。
3. RefImpl 包装类 构造器中，浅比较直接返回值，非浅比较则使用 toReactive 转换响应式。当值为对象类型则直接调用 reactive() 使用 Proxy 包装
4. 通过 RefImpl 包装类 的包装类的 getter 和 setter 来触发依赖收集和派发更新流程。

## 2 ref 底层是否会使用 reactive 处理数据

### 2.1 源码分析

通过 RefImpl 包装类 源码 中构建器 对 传入值的处理可知，当没有开启浅比较的时候

- 如果 ref 代理的值是对象类型，则直接调用 reactive 处理
- 如果 ref 代理的值是基础类型，则直接返回原始值。

```js
	// RefImpl 包装类 构造器。详细见 1.3
	constructor(value: T, isShallow: boolean) {
		// 非浅比较 用 toRaw() 处理原始值。toRaw源码见 1.4
		this._rawValue = isShallow ? value : toRaw(value)
		// 非浅比较 用 toReactive() 处理值。toReactive源码见 1.4
		this._value = isShallow ? value : toReactive(value)
		this[ReactiveFlags.IS_SHALLOW] = isShallow
	}

	// 响应式处理。详细见 1.4
	export const toReactive = <T extends unknown>(value: T): T =>
  isObject(value) ? reactive(value) : value
```

### 2.2 面试回答

ref 底层使用 reactive 处理数据 需要两个前置条件，不开启浅比较和 ref 代理的值为对象类型。

## 3 为什么已经有了 reactive 还需要在设计一个 ref 呢？

reactive 底层使用了 Proxy 代理值，这个值只能是任何类型的对象，包括原生的数组、函数甚至是另一个代理对象。但是无法处理基本类型。所以处理基础类型需要包裹一层

## 4 为什么 ref 数据必须要有个 value 属性，访问 ref 数据必须要通过.value 的方式呢？

通过对 RefImpl 包装类可知，底层通过 getter 和 setter 来进行属性劫持来触发更新。所以访问和修改时必须使用 value。

```js
// RefImpl 包装类 详细见1.3
class RefImpl<T = any> {
  // 管理依赖更新
  dep: Dep = new Dep();
  constructor(value: T, isShallow: boolean) {}
  // getter 收集依赖
  get value() {}
  // setter 触发依赖更新
  set value(newValue) {}
}
```
