# Dot-sourced by every Verminal PowerShell pane.
[Console]::OutputEncoding = [Text.Encoding]::UTF8

if ($env:VERMINAL_REAL_CLAUDE) {
  function global:claude { & $env:VERMINAL_REAL_CLAUDE --settings $env:VERMINAL_HOOKS @args }
}

# Report the working directory to the terminal (OSC 9;9) on every prompt.
$global:__verminalPrompt = $function:prompt
function global:prompt {
  $loc = $executionContext.SessionState.Path.CurrentLocation
  if ($loc.Provider.Name -eq 'FileSystem') { [Console]::Write("$([char]27)]9;9;$($loc.ProviderPath)$([char]7)") }
  & $global:__verminalPrompt
}

if ($env:VERMINAL_INIT_CMD) {
  $__cmd = $env:VERMINAL_INIT_CMD
  Remove-Item Env:VERMINAL_INIT_CMD
  Invoke-Expression $__cmd
}
