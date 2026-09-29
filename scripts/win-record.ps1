# 로그인 세션에서 명령 세트 하나를 돌려 응답을 원시 바이트로 남긴다. 날개를 쓰는 호출과 채팅 전송은 어느 세트에도 없다.
# 실행 명령은 거부가 확실한 상태에서만 부른다. execute_gathering은 부르기 전에 그 이름의 채집물이 없음을 확인하고, 있거나 확인이 안 되면(field) 멈춘다.
# write_chat은 승인 창 없이 즉시 전송된다(실측 2026-09-29 · recordings/write_chat.json). 세트에 두지 않는다.
# 사용: win-record.ps1 -Out <출력 디렉터리> -Cli <CLI 경로> -Set queries|field|outside
#   queries  조회 19개. 캐릭터가 필드에 있어야 한다
#   field    필드에서 거부되는 실행 명령. 서 있고 아무 행동도 하지 않는 상태
#   outside  게임 밖(로그인·캐릭터 선택 화면·게임 종료)에서 status·조회·실행 각 1회. 필드가 아닌 상황이라 recordings/의 하위 디렉터리에 담는다
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Cli,
  [Parameter(Mandatory = $true)][ValidateSet("queries", "field", "outside")][string]$Set
)
$ErrorActionPreference = "Stop"
$absentItem = "마비서없는아이템"
$sets = @{
  queries = @(
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
  field = @(
    @{ name = "stand_up"; label = "standing" },
    @{ name = "stop_action"; label = "idle" },
    @{ name = "execute_gathering"; label = "unknown-name"; body = "{`"displayName`":`"$absentItem`"}" }
  )
  outside = @(
    @{ name = "status" },
    @{ name = "get_my_info" },
    @{ name = "execute_gathering"; body = "{`"displayName`":`"$absentItem`"}" },
    @{ name = "stand_up" }
  )
}
$queries = $sets[$Set]
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Remove-Item "$Out\*" -Force -ErrorAction SilentlyContinue
$index = @("file`texit`tms`tbytes`tcommand`tbody")
function Invoke-Cli([string]$name, [string]$body) {
  $arguments = $name
  if ($body) { $arguments += ' "' + ($body -replace '"', '\"') + '"' }
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
  return @{ bytes = $ms.ToArray(); err = $err; exit = $p.ExitCode; ms = $sw.ElapsedMilliseconds }
}

if ($queries | Where-Object { $_.name -eq "execute_gathering" }) {
  $found = Invoke-Cli "get_gatherable_items" $absentItem
  $parsed = [System.Text.Encoding]::UTF8.GetString($found.bytes) | ConvertFrom-Json
  if ($parsed.items -and $parsed.items.Count -gt 0) { throw "채집물 '$absentItem'이 실재한다. execute_gathering을 부르면 날개가 나가므로 멈춘다" }
  if ($Set -eq "field" -and $null -eq $parsed.items) { throw "get_gatherable_items 응답에 items가 없다. 거부가 확실한지 확인할 수 없으므로 멈춘다" }
}

foreach ($q in $queries) {
  $file = if ($q.label) { "$($q.name).$($q.label).json" } else { "$($q.name).json" }
  $r = Invoke-Cli $q.name $q.body
  [System.IO.File]::WriteAllBytes("$Out\$file", $r.bytes)
  if ($r.err) { [System.IO.File]::WriteAllText("$Out\$($file -replace '\.json$', '.stderr.txt')", $r.err, [System.Text.Encoding]::UTF8) }
  $index += "$file`t$($r.exit)`t$($r.ms)`t$($r.bytes.Length)`t$($q.name)`t$($q.body)"
}
[System.IO.File]::WriteAllLines("$Out\index.tsv", $index, [System.Text.UTF8Encoding]::new($false))
Get-Content "$Out\index.tsv"
