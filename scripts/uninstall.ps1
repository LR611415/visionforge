<#
  VisionForge 一键卸载脚本（引导式，安全优先）

  用法:
    powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1          # 引导确认
    powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -Yes     # 跳过确认（自动）

  清理范围（全部与 VisionForge 相关，不触碰 DSH 官方组件与其他插件）:
    1. desktop / web 等 profile 的 package.json、pnpm-lock.yaml 中 @lr611/visionforge 声明
    2. 各 profile node_modules\@lr611\ 目录（插件本体 + .bak 备份）
    3. 插件配置与密钥  ~\.visionforge\
    4. 缓存目录       D:\VisionForge\（含已下载副本！-Yes 前请确认无需保留）

  保留项:
    - D:\ 根目录下已下载的图片（独立副本，不在 D:\VisionForge 内）
    - DSH 官方组件与其他插件（零影响）
#>
[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'

function Show-Header { Write-Host "`n==== VisionForge 卸载清理 ====" -ForegroundColor Cyan }
function Info($m) { Write-Host "[*] $m" -ForegroundColor Gray }
function Ok($m) { Write-Host "[OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }

Show-Header
$profilesDir = Join-Path $env:USERPROFILE '.dsh\profiles'
if (-not (Test-Path $profilesDir)) { Warn "未找到 $profilesDir —— 看起来本机没有 DSH profile，跳过插件目录清理" }

# 1) 收集将删除的内容
$targets = @()
if (Test-Path $profilesDir) {
    Get-ChildItem $profilesDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $pkg = Join-Path $_.FullName 'package.json'
        if (Test-Path $pkg) {
            $raw = Get-Content $pkg -Raw -Encoding UTF8
            if ($raw -match '@lr611/visionforge') { $targets += "声明: $($_.Name)\package.json" }
        }
        $nm = Join-Path $_.FullName 'node_modules\@lr611'
        if (Test-Path $nm) { $targets += "插件目录: $($_.Name)\node_modules\@lr611\" }
        $lock = Join-Path $_.FullName 'pnpm-lock.yaml'
        if (Test-Path $lock) {
            $lraw = Get-Content $lock -Raw -Encoding UTF8
            if ($lraw -match '@lr611/visionforge') { $targets += "锁文件: $($_.Name)\pnpm-lock.yaml" }
        }
    }
}
$vfHome = Join-Path $env:USERPROFILE '.visionforge'
if (Test-Path $vfHome) { $targets += "配置与密钥: $vfHome\" }
$vfCache = 'D:\VisionForge'
if (Test-Path $vfCache) { $targets += "缓存目录(含已下载副本): $vfCache\" }
$vfCacheAlt = Join-Path $env:USERPROFILE 'VisionForge'
if (Test-Path $vfCacheAlt) { $targets += "备用缓存: $vfCacheAlt\" }

if ($targets.Count -eq 0) { Ok '未发现任何 VisionForge 相关残留，无需清理。' ; exit 0 }

Write-Host "`n将删除以下内容：" -ForegroundColor Yellow
$targets | ForEach-Object { Write-Host "  - $_" }

if (-not $Yes) {
    Write-Host "`n确认删除？输入 y 继续，其他任意键取消：" -ForegroundColor Cyan -NoNewline
    $ans = Read-Host
    if ($ans -notmatch '^[yY]$') { Warn '已取消，未做任何修改。' ; exit 1 }
}

# 2) 清理声明与插件目录
if (Test-Path $profilesDir) {
    Get-ChildItem $profilesDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $pkg = Join-Path $_.FullName 'package.json'
        if (Test-Path $pkg) {
            $raw = Get-Content $pkg -Raw -Encoding UTF8
            if ($raw -match '@lr611/visionforge') {
                $pj = $raw | ConvertFrom-Json
                $pj.dependencies.PSObject.Properties.Remove('@lr611/visionforge')
                $b = $pj.dsh.profile.bundles
                if ($b) { $pj.dsh.profile.bundles = @($b | Where-Object { $_ -ne '@lr611/visionforge' }) }
                $new = $pj | ConvertTo-Json -Depth 10
                [IO.File]::WriteAllText($pkg, $new, [Text.UTF8Encoding]::new($false))
                Ok "已清理 $($_.Name)\package.json 中的 visionforge 声明"
            }
        }
        $nm = Join-Path $_.FullName 'node_modules\@lr611'
        if (Test-Path $nm) { Remove-Item -Recurse -Force $nm ; Ok "已删除 $($_.Name)\node_modules\@lr611\" }
        $lock = Join-Path $_.FullName 'pnpm-lock.yaml'
        if (Test-Path $lock) {
            $lraw = Get-Content $lock -Raw -Encoding UTF8
            if ($lraw -match '@lr611/visionforge') { Info "pnpm-lock.yaml 仍含 visionforge 引用 —— 建议在 DSH 重启后执行 npm install / pnpm install 重新生成" }
        }
    }
}

# 3) 配置与缓存
if (Test-Path $vfHome) { Remove-Item -Recurse -Force $vfHome ; Ok "已删除 $vfHome" }
if (Test-Path $vfCache) { Remove-Item -Recurse -Force $vfCache ; Ok "已删除 $vfCache" }
if (Test-Path $vfCacheAlt) { Remove-Item -Recurse -Force $vfCacheAlt ; Ok "已删除 $vfCacheAlt" }

Show-Header
Ok 'VisionForge 已清理。请完全重启 DSH Desktop 使改动生效。'
Write-Host 'D:\ 根目录下已下载的图片是独立副本，未删除；如需删除请自行确认。' -ForegroundColor Yellow
