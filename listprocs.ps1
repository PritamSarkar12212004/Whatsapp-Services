Get-CimInstance Win32_Process -Filter "name='node.exe'" | ForEach-Object {
    $cmd = $_.CommandLine
    if ($cmd -and $cmd.Length -gt 100) { $cmd = $cmd.Substring(0, 100) }
    '{0} :: {1}' -f $_.ProcessId, $cmd
}
