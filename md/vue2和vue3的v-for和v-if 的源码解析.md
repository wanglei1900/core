

# vue2 v-for和v-if 源码解析

源码地址： `vue\src\compiler\codegen\index.ts`

vue2 编译的三个过程
- parse：将模板解析为AST语法树
- optimize：优化AST语法树，主要时标记静态节点，提高更新页面的性能
- codegen：生成编译后的代码

### vue2 生成vnode节点 逻辑
```ts
export function genElement(el: ASTElement, state: CodegenState): string {
  if (el.parent) {
    el.pre = el.pre || el.parent.pre
  }

  if (el.staticRoot && !el.staticProcessed) {
    return genStatic(el, state)
  } else if (el.once && !el.onceProcessed) {
    return genOnce(el, state)
    // # 可以得知 v-for 是先于 v-if 解析的
  } else if (el.for && !el.forProcessed) {
    return genFor(el, state)
  } else if (el.if && !el.ifProcessed) {
    return genIf(el, state)
  } else if (el.tag === 'template' && !el.slotTarget && !state.pre) {
    return genChildren(el, state) || 'void 0'
  } else if (el.tag === 'slot') {
    return genSlot(el, state)
  } else {
    // component or element
    let code
    if (el.component) {
      code = genComponent(el.component, el, state)
    } else {
      let data
      const maybeComponent = state.maybeComponent(el)
      if (!el.plain || (el.pre && maybeComponent)) {
        data = genData(el, state)
      }

      let tag: string | undefined
      // check if this is a component in <script setup>
      const bindings = state.options.bindings
      if (maybeComponent && bindings && bindings.__isScriptSetup !== false) {
        tag = checkBindingType(bindings, el.tag)
      }
      if (!tag) tag = `'${el.tag}'`

      const children = el.inlineTemplate ? null : genChildren(el, state, true)
      code = `_c(${tag}${
        data ? `,${data}` : '' // data
      }${
        children ? `,${children}` : '' // children
      })`
    }
    // module transforms
    for (let i = 0; i < state.transforms.length; i++) {
      code = state.transforms[i](el, code)
    }
    return code
  }
}

```


### vue2 v-for 逻辑
```ts
export function genFor(
  el: any,
  state: CodegenState,
  altGen?: Function,
  altHelper?: string
): string {
  const exp = el.for
  const alias = el.alias
  const iterator1 = el.iterator1 ? `,${el.iterator1}` : ''
  const iterator2 = el.iterator2 ? `,${el.iterator2}` : ''

  if (
    __DEV__ &&
    state.maybeComponent(el) &&
    el.tag !== 'slot' &&
    el.tag !== 'template' &&
    !el.key
  ) {
    state.warn(
      `<${el.tag} v-for="${alias} in ${exp}">: component lists rendered with ` +
        `v-for should have explicit keys. ` +
        `See https://v2.vuejs.org/v2/guide/list.html#key for more info.`,
      el.rawAttrsMap['v-for'],
      true /* tip */
    )
  }
  // # for流程标识符 
  // # forProcessed 赋值为true 标识 v-for 指令已经执行结束
  el.forProcessed = true // avoid recursion
  // # 再次调用 genElement 函数
  return (
    `${altHelper || '_l'}((${exp}),` +
    `function(${alias}${iterator1}${iterator2}){` +
    `return ${(altGen || genElement)(el, state)}` +
    '})'
  )
}
```

### vue2 v-if 逻辑
```ts
export function genIf(
  el: any,
  state: CodegenState,
  altGen?: Function,
  altEmpty?: string
): string {
  // # 将 forProcessed 赋值为true
  el.ifProcessed = true // avoid recursion
  return genIfConditions(el.ifConditions.slice(), state, altGen, altEmpty)
}

function genIfConditions(
  conditions: ASTIfConditions,
  state: CodegenState,
  altGen?: Function,
  altEmpty?: string
): string {
  if (!conditions.length) {
    return altEmpty || '_e()'
  }

  const condition = conditions.shift()!
  if (condition.exp) {
    return `(${condition.exp})?${genTernaryExp(
      condition.block
    )}:${genIfConditions(conditions, state, altGen, altEmpty)}`
  } else {
    return `${genTernaryExp(condition.block)}`
  }

  // v-if with v-once should generate code like (a)?_m(0):_m(1)
  // # if渲染逻辑
  function genTernaryExp(el) {
    return altGen
      ? altGen(el, state)
      : el.once
      ? genOnce(el, state)
      : genElement(el, state)
  }
}
```

### vue2 v-for 性能问题
极限工况演示
```html
  <div v-for="item in 9999999999999" v-if="false">演示</div>
  <div v-for="item in 2" v-if="false">演示</div>
```

编译后代码
```js
/* 
 _c：createElement函数，创建 VNode
 _l：renderList函数，渲染列表
 _c：createEmptyVNode函数，创建空VNode，使用空注释符占位
*/
function render() {
  with(this) {
    return _c('div', _l((arr), function (item) {
      return (exists) ? _c('li', {
        key: item
      }) : _e()
    }), 0)
  }
}
```

性能问题根源：由于vue2先执行v-for在执行v-if，即使所有节点v-if为false，仍然需要遍历并创建全部vnode节点。sandbox内测试vue2，导致页面内存暴增，页面卡死。


# vue3 v-for和v-if 源码解析

### vue3 模版编译转换器顺序

源码位置：`core\packages\compiler-core\src\compile.ts`

```ts
// # 转换器顺序的优先级控制
export function getBaseTransformPreset(
  prefixIdentifiers?: boolean,
): TransformPreset {
  return [
    [
      transformOnce,
      // # 先处理v-if，v-if 的条件判断被提升到外层作用域
      transformIf,
      transformMemo,
      // # 在处理v-for
      transformFor,
      ...(__COMPAT__ ? [transformFilter] : []),
      ...(!__BROWSER__ && prefixIdentifiers
        ? [
            // order is important
            trackVForSlotScopes,
            transformExpression,
          ]
        : __BROWSER__ && __DEV__
          ? [transformExpression]
          : []),
      transformSlotOutlet,
      transformElement,
      trackSlotScopes,
      transformText,
    ],
    {
      on: transformOn,
      bind: transformBind,
      model: transformModel,
    },
  ]
}
```

### createIfBranch 函数负责生成条件分支的 AST 节点。

源码位置：`core\packages\compiler-core\src\transforms\vIf.ts`


```ts
function createIfBranch(node: ElementNode, dir: DirectiveNode): IfBranchNode {
  const isTemplateIf = node.tagType === ElementTypes.TEMPLATE
  return {
    type: NodeTypes.IF_BRANCH,
    loc: node.loc,
    condition: dir.name === 'else' ? undefined : dir.exp,
    // # 对于没有 v-for 的 template 节点，v-if 的条件分支内容是其子节点；（纯逻辑容器）
    // # 其他情况（非 template 节点或含有 v-for），将节点本身作为分支内容
    children: isTemplateIf && !findDir(node, 'for') 
      ? node.children  // # 使用子节点
      : [node],        // # 使用当前节点自身
    userKey: findProp(node, `key`),
    isTemplateIf,
  }
}
```
当 v-if 和 v-for 同时存在时，children: [node] 会将当前节点作为条件分支内容，导致 v-if 的条件判断被提升到 v-for 外层

### vue3 v-for 性能问题
```html
  <div v-for="item in 9999999999999" v-if="item % 2===0">演示</div>
```

- 在Vue 2中，由于v-for的优先级高于v-if，当v-if使用了v-for的遍历结果时，Vue 2会对每个元素都执行v-if条件判断。这可能导致性能问题，特别是在数据量较大时。
- 而在Vue 3中，由于v-if的优先级高于v-for，Vue 3会在编译阶段对v-if进行静态提升(static hoisting)，只对整个元素进行一次条件判断，而不会对每个元素都执行条件判断。这样可以提高性能，特别是在大型列表渲染时



```js
// 三目表达式 提前判断
function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock(_Fragment, null, [
    (_ctx.item % 2===0)
      ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, _renderList(9999999999999, (item) => {
          return _createElementVNode("div", null, "演示")
        }), 64 /* STABLE_FRAGMENT */))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" <div v-for=\"item in 99\" >\n\t\t\t<span v-if=\"item % 2 ===0\">{{item}}</span>\n\t\t</div> ")
  ], 2112 /* STABLE_FRAGMENT, DEV_ROOT_FRAGMENT */))
}
```

# 结论

- vue2 中 v-for的优先级高于v-if
- vue3 中 v-if的优先级高于v-for

# 注意事项

讨论了那么多，其实也是应付面试，实际开发。

- template 标签 包裹并提升v-for
- 使用计算属性提前计算好
