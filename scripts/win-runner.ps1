# 세션 1(로그인 세션)에서 도는 실행기. 작업 스케줄러 작업 mabiseo-run이 이 파일을 부른다.
# cmd.txt의 명령을 cwd.txt 위치에서 실행하고 out.txt와 done.txt(종료 코드)를 남긴다. 문제는 log.txt에 남는다.
$w = "$env:USERPROFILE\mabiseo-runner"
$log = "$w\log.txt"
"$(Get-Date -Format s) start session=$((Get-Process -Id $PID).SessionId)" | Set-Content $log
try {
  Remove-Item "$w\out.txt", "$w\err.txt", "$w\done.txt" -ErrorAction SilentlyContinue
  $cmd = (Get-Content "$w\cmd.txt" -Raw -Encoding UTF8).Trim()
  $cwd = if (Test-Path "$w\cwd.txt") { (Get-Content "$w\cwd.txt" -Raw).Trim() } else { "" }
  if (-not $cwd -or -not (Test-Path $cwd)) { $cwd = $env:USERPROFILE }
  "cmd=$cmd" | Add-Content $log
  "cwd=$cwd" | Add-Content $log
  $p = Start-Process -FilePath "$env:ComSpec" -ArgumentList "/d /c chcp 65001>nul && $cmd" -WorkingDirectory $cwd `
    -RedirectStandardOutput "$w\out.txt" -RedirectStandardError "$w\err.txt" -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop
  $code = $p.ExitCode
  if ((Test-Path "$w\err.txt") -and (Get-Item "$w\err.txt").Length -gt 0) {
    Add-Content "$w\out.txt" (Get-Content "$w\err.txt" -Raw -Encoding UTF8) -Encoding UTF8
  }
  "exit=$code" | Add-Content $log
} catch {
  "error=$($_.Exception.Message)" | Add-Content $log
  "error=$($_.Exception.Message)" | Set-Content "$w\out.txt" -Encoding UTF8
  $code = 1
}
Set-Content "$w\done.txt" ([string]$code)
