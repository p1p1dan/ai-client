# text-kit 项目规则

- 不要新增任何依赖，也不要修改 `package.json`。
- 不要使用 `var`；不要在 `src/` 里留下 `console.log`。
- 各个公共选项的默认值统一放在 `src/config.js` 的 `DEFAULTS` 里，并在 `resolveOptions` 里校验。
- 新功能必须有测试；改完运行 `node --test`，全部通过才算完成。
