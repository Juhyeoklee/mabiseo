# 세션 1(로그인 세션)에서 도는 실행기. 작업 스케줄러 작업 mabiseo-run이 이 파일을 부른다.
# cmd.txt의 명령을 cwd.txt 위치에서 실행하고 out.txt와 done.txt(종료 코드)를 남긴다. 문제는 log.txt에 남는다.
# pid.txt에는 띄운 cmd의 PID가 남는다. 작업을 끝내도 자식 트리는 살아남으므로 끌 때는 이 PID를 트리째 끝낸다.
# -Slot을 주면 파일 이름 앞에 "<slot>."이 붙는다. 오래 떠 있는 serve(작업 mabiseo-serve)가 짧은 명령과 파일을 다투지 않게
param([string]$Slot = "")
$w = "$env:USERPROFILE\mabiseo-runner"
$p = if ($Slot) { "$Slot." } else { "" }
$log = "$w\${p}log.txt"
"$(Get-Date -Format s) start session=$((Get-Process -Id $PID).SessionId)" | Set-Content $log
try {
  Remove-Item "$w\${p}out.txt", "$w\${p}err.txt", "$w\${p}done.txt" -ErrorAction SilentlyContinue
  $cmd = (Get-Content "$w\${p}cmd.txt" -Raw -Encoding UTF8).Trim()
  $cwd = if (Test-Path "$w\${p}cwd.txt") { (Get-Content "$w\${p}cwd.txt" -Raw).Trim() } else { "" }
  if (-not $cwd -or -not (Test-Path $cwd)) { $cwd = $env:USERPROFILE }
  "cmd=$cmd" | Add-Content $log
  "cwd=$cwd" | Add-Content $log
  $proc = Start-Process -FilePath "$env:ComSpec" -ArgumentList "/d /c chcp 65001>nul && $cmd" -WorkingDirectory $cwd `
    -RedirectStandardOutput "$w\${p}out.txt" -RedirectStandardError "$w\${p}err.txt" -WindowStyle Hidden -PassThru -ErrorAction Stop
  # 핸들을 먼저 잡아 두지 않으면 -Wait 없이 띄운 프로세스의 ExitCode가 비어 온다
  $null = $proc.Handle
  Set-Content "$w\${p}pid.txt" ([string]$proc.Id)
  $proc.WaitForExit()
  $code = $proc.ExitCode
  if ((Test-Path "$w\${p}err.txt") -and (Get-Item "$w\${p}err.txt").Length -gt 0) {
    Add-Content "$w\${p}out.txt" (Get-Content "$w\${p}err.txt" -Raw -Encoding UTF8) -Encoding UTF8
  }
  "exit=$code" | Add-Content $log
} catch {
  "error=$($_.Exception.Message)" | Add-Content $log
  "error=$($_.Exception.Message)" | Set-Content "$w\${p}out.txt" -Encoding UTF8
  $code = 1
}
Set-Content "$w\${p}done.txt" ([string]$code)
