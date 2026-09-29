# done.txt가 생길 때까지 기다렸다가 종료 코드를 출력한다. 인자: 최대 대기 초
param([int]$timeout = 600)
$w = "$env:USERPROFILE\mabiseo-runner"
$deadline = (Get-Date).AddSeconds($timeout)
while (-not (Test-Path "$w\done.txt")) {
  if ((Get-Date) -gt $deadline) { Write-Output "timeout"; exit 124 }
  Start-Sleep -Milliseconds 300
}
Get-Content "$w\done.txt"
