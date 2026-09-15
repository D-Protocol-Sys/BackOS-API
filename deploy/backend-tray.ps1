# ==============================================================================
# backend-tray.ps1 — Icône de zone de notification pour piloter le backend
# ------------------------------------------------------------------------------
# Ne pas double-cliquer directement sur ce fichier (ça ouvrirait une fenêtre
# PowerShell visible). Utilise "backend-tray.vbs" à la place, qui lance ce
# script en arrière-plan sans aucune fenêtre.
# ==============================================================================

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ScriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot  = Split-Path -Parent $ScriptDir
$ComposeFile  = Join-Path $ScriptDir "docker-compose.lan.yml"
$EnvFile      = Join-Path $ProjectRoot ".env.lan"

# --- Fabrique de petites icônes "pastille de couleur" (aucun fichier .ico requis) ---
function New-DotIcon([System.Drawing.Color]$color) {
    $bmp = New-Object System.Drawing.Bitmap(16, 16)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush($color)
    $g.FillEllipse($brush, 1, 1, 13, 13)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(60,60,60), 1)
    $g.DrawEllipse($pen, 1, 1, 13, 13)
    [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$IconRunning = New-DotIcon ([System.Drawing.Color]::FromArgb(0, 180, 80))
$IconStopped = New-DotIcon ([System.Drawing.Color]::FromArgb(150, 150, 150))
$IconBusy    = New-DotIcon ([System.Drawing.Color]::FromArgb(235, 165, 20))
$IconError   = New-DotIcon ([System.Drawing.Color]::FromArgb(210, 40, 40))

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = $IconBusy
$notifyIcon.Text = "Backend : verification..."
$notifyIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add("Statut : verification...")
$statusItem.Enabled = $false
[void]$menu.Items.Add("-")
$startItem  = $menu.Items.Add("Demarrer")
$stopItem   = $menu.Items.Add("Arreter")
[void]$menu.Items.Add("-")
$logsItem   = $menu.Items.Add("Voir les logs")
$healthItem = $menu.Items.Add("Tester http://localhost:4803/api/health")
[void]$menu.Items.Add("-")
$exitItem   = $menu.Items.Add("Quitter (masque juste l'icone)")
$notifyIcon.ContextMenuStrip = $menu

$script:busy = $false

function Get-BackendStatus {
    try {
        $raw = & docker compose -f $ComposeFile --env-file $EnvFile ps --format json 2>$null
        if (-not $raw) { return "stopped" }
        $lines = $raw -split "`r?`n" | Where-Object { $_.Trim() -ne "" }
        if ($lines.Count -eq 0) { return "stopped" }
        $states = @()
        foreach ($line in $lines) {
            try {
                $obj = $line | ConvertFrom-Json
                if ($obj -is [array]) { $states += $obj.State } else { $states += $obj.State }
            } catch {}
        }
        if ($states.Count -eq 0) { return "stopped" }
        if ($states -contains "exited" -or $states -contains "dead") { return "error" }
        if (($states | Where-Object { $_ -ne "running" }).Count -gt 0) { return "starting" }
        return "running"
    } catch {
        return "unknown"
    }
}

function Update-Status {
    if ($script:busy) { return }
    $state = Get-BackendStatus
    switch ($state) {
        "running" {
            $notifyIcon.Icon = $IconRunning
            $notifyIcon.Text = "Backend : en marche"
            $statusItem.Text = "Statut : EN MARCHE"
            $startItem.Enabled = $false; $stopItem.Enabled = $true
        }
        "stopped" {
            $notifyIcon.Icon = $IconStopped
            $notifyIcon.Text = "Backend : arrete"
            $statusItem.Text = "Statut : ARRETE"
            $startItem.Enabled = $true; $stopItem.Enabled = $false
        }
        "starting" {
            $notifyIcon.Icon = $IconBusy
            $notifyIcon.Text = "Backend : demarrage en cours..."
            $statusItem.Text = "Statut : DEMARRAGE..."
            $startItem.Enabled = $false; $stopItem.Enabled = $false
        }
        default {
            $notifyIcon.Icon = $IconError
            $notifyIcon.Text = "Backend : erreur, verifie les logs"
            $statusItem.Text = "Statut : ERREUR (voir logs)"
            $startItem.Enabled = $true; $stopItem.Enabled = $true
        }
    }
}

function Invoke-DockerAction([string[]]$DockerArgs, [string]$BusyText, [string]$DoneText) {
    $script:busy = $true
    $notifyIcon.Icon = $IconBusy
    $notifyIcon.Text = $BusyText
    $statusItem.Text = $BusyText

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "docker"
    $psi.Arguments = ($DockerArgs -join " ")
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $proc = [System.Diagnostics.Process]::Start($psi)

    $watchTimer = New-Object System.Windows.Forms.Timer
    $watchTimer.Interval = 1000
    $watchTimer.Add_Tick({
        if ($proc.HasExited) {
            $watchTimer.Stop(); $watchTimer.Dispose()
            $script:busy = $false
            Update-Status
            $notifyIcon.ShowBalloonTip(3000, "Backend", $DoneText, [System.Windows.Forms.ToolTipIcon]::Info)
        }
    })
    $watchTimer.Start()
}

$startItem.Add_Click({
    Invoke-DockerAction @("compose","-f",$ComposeFile,"--env-file",$EnvFile,"up","-d","--build") `
        "Demarrage en cours..." "Backend demarre (ou en train de finir de demarrer)."
})
$stopItem.Add_Click({
    Invoke-DockerAction @("compose","-f",$ComposeFile,"--env-file",$EnvFile,"stop") `
        "Arret en cours..." "Backend arrete. Ressources liberees."
})
$logsItem.Add_Click({
    Start-Process powershell -ArgumentList "-NoExit","-Command","cd `"$ProjectRoot`"; docker compose -f `"$ComposeFile`" --env-file `"$EnvFile`" logs -f orchestrator"
})
$healthItem.Add_Click({
    Start-Process "http://localhost:4803/api/health"
})
$exitItem.Add_Click({
    $notifyIcon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})
$notifyIcon.Add_DoubleClick({
    if ((Get-BackendStatus) -eq "running") { Start-Process "http://localhost:4803/api/health" }
})

$refreshTimer = New-Object System.Windows.Forms.Timer
$refreshTimer.Interval = 15000
$refreshTimer.Add_Tick({ Update-Status })
$refreshTimer.Start()

Update-Status
[System.Windows.Forms.Application]::Run()
