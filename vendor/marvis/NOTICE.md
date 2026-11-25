# 腾讯 Marvis 供应商（vendored）

- 来源：`MYCF711/magpie-marvis` v0.2.57（MIT），2026-11-25 起按社区修复版
  `facron2004/magpie-marvis-fix`（0.2.58）的改动更新，见 `src/marvis/beacon-shim.mjs`
  与 `native/marvis_beacon_shim.c`。
- 上游仓库已暂停维护，升级前先确认新版是否仍带这套修复。

## native/ 里的文件

| 文件 | 来源 | 能否随仓库分发 |
|---|---|---|
| `beacon_wrapper.dll` / `beacon_sdk.dll` / `qimei.dll` | 腾讯 Marvis 官方 Windows 客户端（`Marvis/win32-native/`） | 否，客户端文件，升级客户端后替换 |
| `beacon_shim.dll` | 由 `marvis_beacon_shim.c` 编译，见下 | 可以，但本机编译产物默认不入库 |
| `marvis_beacon_shim.c` | 社区修复版源码 | 可以 |

缺任意一个官方 DLL 时插件仍能加载，但模型请求会一直回 `4100404 风控拦截`——那是
「uskey 没有按本次请求由 Beacon SDK 现签」，不是登录或额度问题。

## 插件如何自动补齐

`runtime/marvis-native.mjs` 每天检查一次，顺序是：

1. **本机装了 Marvis 客户端** → 直接用它 `win32-native` 里的三个 DLL（内容不同才复制）。
   这样版本永远跟用户自己的客户端一致。
2. **没装客户端** → 从本仓库 GitHub Release 的 `marvis-native.zip` 附件下载整套
   （含这三个 DLL 与 `beacon_shim.dll`），解压到 `native/`。

`beacon_shim.dll` 与客户端版本无关：它在运行时从 `beacon_get_uskey` 的函数体里定位
Client 单例，所以客户端升级不用重编；Release 附件里的三个官方 DLL 才有版本含义，
发版时用 `node scripts/marvis-native-pack.mjs` 重新打包上传即可。

## 重新编译 shim

本机没有装 Windows SDK，用 NuGet 包提供头文件与库：

```bat
call "<Visual Studio>\VC\Auxiliary\Build\vcvars64.bat"
set "SDKINC=<nuget>\microsoft.windows.sdk.cpp\c\Include\10.0.22621.0"
set "SDKLIB=<nuget>\microsoft.windows.sdk.cpp.x64\c"
set "INCLUDE=%SDKINC%\ucrt;%SDKINC%\um;%SDKINC%\shared;%SDKINC%\winrt;%INCLUDE%"
set "LIB=%SDKLIB%\ucrt\x64;%SDKLIB%\um\x64;%LIB%"
cl /nologo /LD /O2 /W3 /utf-8 marvis_beacon_shim.c /link /MACHINE:X64 /OUT:beacon_shim.dll
```

不需要在客户端升级后重编：桥在运行时从 `beacon_get_uskey` 的函数体里定位 Client 单例。
