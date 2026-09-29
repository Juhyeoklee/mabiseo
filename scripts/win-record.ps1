# 로그인 세션에서 조회 명령을 한 번씩 돌려 응답을 원시 바이트로 남긴다. 실행 명령(날개·채팅)은 목록에 넣지 않는다.
# 사용: win-record.ps1 -Out <출력 디렉터리> -Cli <CLI 경로>
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Cli
)
$ErrorActionPreference = "Stop"
$queries = @(
  @{ name = "capabilities" },
  @{ name = "get_current_environment" },
  @{ name = "get_activity" },
  @{ name = "get_my_info" },
  @{ name = "get_quests" },
  @{ name = "get_currencies" },
  @{ name = "get_near_npcs" },
  @{ name = "get_near_pcs" },
  @{ name = "get_inventory" },
  @{ name = "get_music_scores" },
  @{ name = "get_instruments" },
  @{ name = "get_items" },
  @{ name = "get_items"; label = "ingredient"; body = '{"category":"Ingredient"}' },
  @{ name = "get_social_actions" },
  @{ name = "get_daily_missions" },
  @{ name = "get_weekly_missions" },
  @{ name = "get_gatherable_items" },
  @{ name = "get_gatherable_items"; label = "log"; body = "통나무" },
  @{ name = "get_alterable_items" },
  @{ name = "get_alterable_items"; label = "mushroom"; body = "버섯" },
  @{ name = "get_altering_works" },
  @{ name = "get_craftable_items" },
  @{ name = "get_craftable_items"; label = "spiderweb"; body = "거미줄" }
)
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Remove-Item "$Out\*" -Force -ErrorAction SilentlyContinue
$index = @("file`texit`tms`tbytes`targs")
foreach ($q in $queries) {
  $file = if ($q.label) { "$($q.name).$($q.label).json" } else { "$($q.name).json" }
  $arguments = $q.name
  if ($q.body) { $arguments += ' "' + ($q.body -replace '"', '\"') + '"' }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Cli
  $psi.Arguments = $arguments
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $p = [System.Diagnostics.Process]::Start($psi)
  $ms = New-Object System.IO.MemoryStream
  $p.StandardOutput.BaseStream.CopyTo($ms)
  $err = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  $sw.Stop()
  [System.IO.File]::WriteAllBytes("$Out\$file", $ms.ToArray())
  if ($err) { [System.IO.File]::WriteAllText("$Out\$($file -replace '\.json$', '.stderr.txt')", $err, [System.Text.Encoding]::UTF8) }
  $index += "$file`t$($p.ExitCode)`t$($sw.ElapsedMilliseconds)`t$($ms.Length)`t$arguments"
}
[System.IO.File]::WriteAllLines("$Out\index.tsv", $index, [System.Text.UTF8Encoding]::new($false))
Get-Content "$Out\index.tsv"
