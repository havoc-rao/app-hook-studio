# 快速体验包开发测试

测试不随独立 ZIP 发布，也不是使用 Python 脚本的依赖。其中的断言检查修改快捷键时是否保留用户注释等行为，防止配置编辑回归。

在项目根目录执行：

```sh
python3 -m unittest discover -s quickstart/tests/codebuddy-hotkeys-quickstart -v
```

提供真实原始 Webview 和扩展主文件路径，可运行临时 App 副本上的集成验证：

```sh
CODEBUDDY_TEST_ORIGINAL='/path/to/main.original.js' \
CODEBUDDY_TEST_HOST='/path/to/extension.original.js' \
python3 -m unittest discover -s quickstart/tests/codebuddy-hotkeys-quickstart -v
```
