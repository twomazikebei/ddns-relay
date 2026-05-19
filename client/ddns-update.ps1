# ddns-update.ps1 - 调用 Cloudflare Worker DDNS 中继上报 IP
#
# 用法:
#   1. 修改下方配置
#   2. 以管理员身份运行 PowerShell,执行下方"注册计划任务"代码段
#
# 注册计划任务(管理员 PowerShell,5 分钟一次,以 SYSTEM 身份):
#
#   $Action  = New-ScheduledTaskAction -Execute "powershell.exe" `
#       -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\Scripts\ddns-update.ps1"
#   $Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
#       -RepetitionInterval (New-TimeSpan -Minutes 5)
#   $Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
#   Register-ScheduledTask -TaskName "DDNS-Update" `
#       -Action $Action -Trigger $Trigger -Principal $Principal

# ============ 配置区 ============
$WorkerUrl     = "https://ddns-relay.your-subdomain.workers.dev"
$Secret        = "REPLACE_WITH_YOUR_SHARED_SECRET"
$Domains       = @("home.example.com", "nas.example.com")
$LogFile       = "C:\Scripts\ddns.log"
$Timeout       = 15
$LogUnchanged  = $false
# ===============================

function Write-DdnsLog($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$ts $msg" | Out-File -FilePath $LogFile -Append -Encoding UTF8
}

function Invoke-DDNSUpdate($Domain) {
    $tag = if ($Domain) { $Domain } else { "default" }
    $url = $WorkerUrl
    if ($Domain) { $url = "$url/?name=$Domain" }

    try {
        $resp = Invoke-RestMethod -Uri $url -Method Post `
            -Headers @{ "X-DDNS-Secret" = $Secret } `
            -TimeoutSec $Timeout `
            -ErrorAction Stop

        if ($resp.ok -eq $true) {
            switch ($resp.action) {
                "updated"   { Write-DdnsLog "OK   [$tag]: updated -> $($resp.ip)" }
                "created"   { Write-DdnsLog "OK   [$tag]: created -> $($resp.ip)" }
                "unchanged" {
                    if ($LogUnchanged) {
                        Write-DdnsLog "OK   [$tag]: unchanged ($($resp.ip))"
                    }
                }
                default     { Write-DdnsLog "OK   [$tag]: $($resp.action) ($($resp.ip))" }
            }
        } else {
            Write-DdnsLog "FAIL [$tag]: $($resp | ConvertTo-Json -Compress)"
        }
    } catch {
        Write-DdnsLog "FAIL [$tag]: $($_.Exception.Message)"
    }
}

# 确保日志目录存在
$LogDir = Split-Path -Parent $LogFile
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

if ($Domains.Count -eq 0) {
    Invoke-DDNSUpdate ""
} else {
    foreach ($d in $Domains) {
        Invoke-DDNSUpdate $d
    }
}
