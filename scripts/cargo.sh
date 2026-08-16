#!/usr/bin/env bash
# 在 Git Bash / 普通 shell 里直接跑 cargo 会因缺少 MSVC 的 INCLUDE/LIB
# 环境变量而编译失败（libsqlite3-sys 的 cc 构建脚本能找到 cl.exe，
# 但 cl.exe 报 "不包括路径集"）。本脚本自动探测本机 MSVC 与 Windows SDK
# 并注入环境后再执行 cargo，用法：
#
#   ./scripts/cargo.sh check
#   ./scripts/cargo.sh test
#   cd server && ../scripts/cargo.sh build
#
# 若你的环境已能直接 cargo build（如 VS Developer Prompt），无需使用本脚本。

set -euo pipefail

find_msvc_include_dir() {
    local root="/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC"
    [ -d "$root" ] || root="/c/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC"
    local best=""
    local version
    for version in "$root"/*; do
        [ -d "$version" ] || continue
        best="$version"
    done
    [ -n "$best" ] || return 1
    echo "$best"
}

find_winsdk_version() {
    local root="/c/Program Files (x86)/Windows Kits/10/Include"
    [ -d "$root" ] || return 1
    local best=""
    local version
    for version in "$root"/*; do
        [ -d "$version" ] || continue
        best="$version"
    done
    [ -n "$best" ] || return 1
    basename "$best"
}

to_win_path() {
    # /c/Program Files/... -> C:\Program Files\...
    local path="$1"
    local drive="${path:1:1}"
    local rest="${path:2}"
    printf '%s:%s' "$(echo "$drive" | tr '[:lower:]' '[:upper:]')" \
        "$(echo "$rest" | sed 's|/|\\\\|g')"
}

MSVC_ROOT="$(find_msvc_include_dir)" || {
    echo "未找到 MSVC BuildTools（请安装 Visual Studio 2022 BuildTools + C++ 桌面开发组件）" >&2
    exit 1
}
WINSDK_VER="$(find_winsdk_version)" || {
    echo "未找到 Windows 10 SDK（请通过 VS 安装器补装 Windows SDK）" >&2
    exit 1
}
WINSDK_ROOT="/c/Program Files (x86)/Windows Kits/10"
SDK_INC="$WINSDK_ROOT/Include/$WINSDK_VER"
SDK_LIB="$WINSDK_ROOT/Lib/$WINSDK_VER"

export INCLUDE="$(to_win_path "$MSVC_ROOT/include");$(to_win_path "$SDK_INC/ucrt");$(to_win_path "$SDK_INC/um");$(to_win_path "$SDK_INC/shared");$(to_win_path "$SDK_INC/winrt");$(to_win_path "$SDK_INC/cppwinrt")"
export LIB="$(to_win_path "$MSVC_ROOT/lib/x64");$(to_win_path "$SDK_LIB/ucrt/x64");$(to_win_path "$SDK_LIB/um/x64")"

exec cargo "$@"
