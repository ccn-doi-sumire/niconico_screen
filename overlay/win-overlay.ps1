<#
  Meet Comment Overlay for Windows.
  Uses only what ships with Windows (PowerShell 5.1 + WPF), so nothing has to be installed.

    powershell -NoProfile -ExecutionPolicy Bypass -STA -File overlay\win-overlay.ps1 [-Screen 1] [-Port 39393]

  Draws a transparent, click-through window over the screen and flows the comments and
  reactions that the Chrome extension sends to http://127.0.0.1:<Port>/event.
  Quit from the tray icon (right click -> 終了).

  NOTE: keep this file saved as UTF-8 *with BOM*; Windows PowerShell 5.1 reads BOM-less files
  in the ANSI code page and the Japanese text would break.
#>
param(
  [int]$Screen = -1,   # -1 = primary screen; 0, 1, ... = index in [System.Windows.Forms.Screen]::AllScreens
  [int]$Port = 39393
)

$ErrorActionPreference = 'Stop'

# WPF needs a single-threaded apartment.
if ([System.Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File $PSCommandPath -Screen $Screen -Port $Port
  exit $LASTEXITCODE
}

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms, System.Drawing

if (-not ('MeetOverlay.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace MeetOverlay {
  public static class Native {
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    // Click-through, never activated, not in Alt+Tab.
    public static void MakeOverlay(IntPtr hwnd) {
      const int GWL_EXSTYLE = -20;
      int ex = GetWindowLong(hwnd, GWL_EXSTYLE);
      ex |= 0x20 | 0x80000 | 0x80 | 0x08000000; // TRANSPARENT | LAYERED | TOOLWINDOW | NOACTIVATE
      SetWindowLong(hwnd, GWL_EXSTYLE, ex);
    }
    // Back to the top of the topmost band (PowerPoint's slide show can cover us otherwise).
    public static void KeepOnTop(IntPtr hwnd) {
      SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); // NOSIZE | NOMOVE | NOACTIVATE
    }
  }
}
'@
}

# fonts.gstatic.com needs TLS 1.2, which older .NET defaults leave off.
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12

# ------------------------------------------------------------------ settings

$Settings = @{
  FontDivisor      = 20     # comment font size = screen height / FontDivisor
  SecondsOnScreen  = 6      # time for a short comment to cross the screen
  MaxComments      = 80
  MaxLength        = 80
  # Reactions match Meet's own (measured): 43 px, straight up at 136 px/s for 3.05 s,
  # fully visible until 72 % of the way and then fading out.
  ReactionSize     = 43
  ReactionSpeed    = 136
  ReactionMs       = 3050
  ReactionFadeFrom = 0.72
  # Every reaction gets its own emoji; nothing is merged or dropped. Above this many on screen
  # they are only drawn more simply, as Meet does: smaller and as a still image.
  BusyReactions    = 24
  ReactionSizeBusy = 32
  ShowAuthor       = $false
}

$State = @{
  Paused       = $false
  Counts       = @{ comments = 0; reactions = 0 }
  Items        = New-Object System.Collections.ArrayList   # @{ Element; EndsAt; Kind }
  Lanes        = @{}                                        # lane index -> DateTime when it frees up
  Clients      = New-Object System.Collections.ArrayList
  ReadBuffer   = New-Object byte[] 65536
  Emoji        = @{}                                        # emoji -> @{ Kind = 'gif'|'png'|'none'; ... }
  Pending      = @{}                                        # emoji -> count, released every 150 ms
  Downloads    = @{}                                        # emoji -> $true while loading
  Random       = New-Object System.Random
  PixelsPerDip = 1.0
  Tick         = 0
  Listener     = $null
  Hwnd         = [IntPtr]::Zero
}

$AnimatedBase = 'https://fonts.gstatic.com/s/e/notoemoji/latest/'
$DefaultReactions = @('💖', '👍', '🎉', '👏', '😂', '😮', '😢', '🤔', '👎')

function Write-Log([string]$Message) {
  Write-Host ('[overlay] ' + $Message)
}

# ------------------------------------------------------------------ window

$graphics = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
$dpiScale = $graphics.DpiX / 96.0
$graphics.Dispose()

# The chosen screen is remembered next to this script (by device name too, in case the order changes).
$SettingsFile = Join-Path $PSScriptRoot '.overlay-settings.json'

function Get-ScreenList {
  $all = [System.Windows.Forms.Screen]::AllScreens
  $list = @()
  for ($i = 0; $i -lt $all.Length; $i++) {
    $list += @{ index = $i; name = ('画面 ' + ($i + 1)); device = $all[$i].DeviceName; width = $all[$i].Bounds.Width; height = $all[$i].Bounds.Height; main = $all[$i].Primary }
  }
  return , $list
}

function Get-SavedScreenIndex {
  $all = [System.Windows.Forms.Screen]::AllScreens
  $primary = [Array]::IndexOf($all, [System.Windows.Forms.Screen]::PrimaryScreen)
  if ($primary -lt 0) { $primary = 0 }
  try {
    if (Test-Path $SettingsFile) {
      $saved = Get-Content -Raw -Encoding UTF8 $SettingsFile | ConvertFrom-Json
      for ($i = 0; $i -lt $all.Length; $i++) { if ($saved.screenName -and $all[$i].DeviceName -eq $saved.screenName) { return $i } }
      if ($saved.screen -is [int] -and $saved.screen -ge 0 -and $saved.screen -lt $all.Length) { return [int]$saved.screen }
    }
  } catch { }
  return $primary
}

# Moves the overlay window onto screen `Index`.
function Set-OverlayScreen([int]$Index) {
  $all = [System.Windows.Forms.Screen]::AllScreens
  if ($Index -lt 0 -or $Index -ge $all.Length) { $Index = 0 }
  $script:ScreenIndex = $Index
  $script:targetScreen = $all[$Index]
  $script:bounds = $script:targetScreen.Bounds
  $Window.Left = $script:bounds.Left / $dpiScale
  $Window.Top = $script:bounds.Top / $dpiScale
  $Window.Width = $script:bounds.Width / $dpiScale
  $Window.Height = $script:bounds.Height / $dpiScale
}

function Save-OverlaySettings {
  try {
    @{ screen = $script:ScreenIndex; screenName = $script:targetScreen.DeviceName } | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 $SettingsFile
  } catch { }
}

$Window = New-Object System.Windows.Window
$Window.Title = 'Meet Comment Overlay'
$Window.WindowStyle = [System.Windows.WindowStyle]::None
$Window.AllowsTransparency = $true
$Window.Background = [System.Windows.Media.Brushes]::Transparent
$Window.Topmost = $true
$Window.ShowInTaskbar = $false
$Window.ShowActivated = $false
$Window.Focusable = $false
$Window.ResizeMode = [System.Windows.ResizeMode]::NoResize
$Window.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
# -Screen on the command line wins; otherwise the screen chosen last time (extension popup).
if ($Screen -ge 0 -and $Screen -lt [System.Windows.Forms.Screen]::AllScreens.Length) { Set-OverlayScreen $Screen } else { Set-OverlayScreen (Get-SavedScreenIndex) }

$Canvas = New-Object System.Windows.Controls.Canvas
$Canvas.IsHitTestVisible = $false
$Canvas.ClipToBounds = $true
$Window.Content = $Canvas

$Window.Add_SourceInitialized({
  $helper = New-Object System.Windows.Interop.WindowInteropHelper($Window)
  $State.Hwnd = $helper.Handle
  [MeetOverlay.Native]::MakeOverlay($State.Hwnd)
})
$Window.Add_Loaded({
  try { $State.PixelsPerDip = [System.Windows.Media.VisualTreeHelper]::GetDpi($Window).PixelsPerDip } catch { $State.PixelsPerDip = $dpiScale }
})

$OutlineBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(220, 0, 0, 0))
$OutlineBrush.Freeze()
$Typeface = New-Object System.Windows.Media.Typeface (
  (New-Object System.Windows.Media.FontFamily 'Yu Gothic UI, Meiryo UI, Meiryo, Segoe UI, Segoe UI Emoji'),
  [System.Windows.FontStyles]::Normal, [System.Windows.FontWeights]::Bold, [System.Windows.FontStretches]::Normal)
$Culture = [System.Globalization.CultureInfo]::GetCultureInfo('ja-JP')

# FontScale / Seconds come with each comment from the extension's settings (0 = default).
function Get-Metrics([double]$FontScale = 0, [double]$Seconds = 0) {
  $w = $Canvas.ActualWidth
  $h = $Canvas.ActualHeight
  if ($w -le 0) { $w = $Window.Width; $h = $Window.Height }
  if ($FontScale -lt 0.3 -or $FontScale -gt 4) { $FontScale = 1 }
  if ($Seconds -lt 1 -or $Seconds -gt 60) { $Seconds = $Settings.SecondsOnScreen }
  $fontSize = [Math]::Max(14, [Math]::Round($h / $Settings.FontDivisor * $FontScale))
  $laneHeight = [Math]::Round($fontSize * 1.3)
  $laneCount = [Math]::Max(1, [Math]::Floor(($h - 8 - $fontSize * 0.5) / $laneHeight))
  return @{ W = $w; H = $h; FontSize = $fontSize; LaneHeight = $laneHeight; LaneCount = $laneCount; Speed = $w / $Seconds }
}

function Add-Item($Element, [double]$Milliseconds, [string]$Kind) {
  [void]$State.Items.Add(@{ Element = $Element; EndsAt = [DateTime]::UtcNow.AddMilliseconds($Milliseconds + 100); Kind = $Kind })
}

function Get-LiveCount([string]$Kind) {
  $n = 0
  foreach ($item in $State.Items) { if ($item.Kind -eq $Kind) { $n++ } }
  return $n
}

# ------------------------------------------------------------------ comments

function Add-Comment([string]$Text, [string]$Author, [double]$FontScale = 0, [double]$Seconds = 0) {
  if ($null -eq $Text) { return }
  $Text = ($Text -replace '\s+', ' ').Trim()
  if (-not $Text) { return }
  if ($Text.Length -gt $Settings.MaxLength) { $Text = $Text.Substring(0, $Settings.MaxLength - 1) + '…' }
  if ($Settings.ShowAuthor -and $Author) { $Text = "$Text  ($Author)" }
  if ((Get-LiveCount 'comment') -ge $Settings.MaxComments) { return }

  $m = Get-Metrics $FontScale $Seconds
  $formatted = New-Object System.Windows.Media.FormattedText ($Text, $Culture, [System.Windows.FlowDirection]::LeftToRight,
    $Typeface, [double]$m.FontSize, [System.Windows.Media.Brushes]::White, [double]$State.PixelsPerDip)
  $geometry = $formatted.BuildGeometry((New-Object System.Windows.Point (0, 0)))
  $geometry.Freeze()
  $strokeWidth = [Math]::Max(2.0, $m.FontSize * 0.14)

  # Outline underneath, white fill on top: the classic flowing-comment look.
  $outline = New-Object System.Windows.Shapes.Path
  $outline.Data = $geometry
  $outline.Stroke = $OutlineBrush
  $outline.StrokeThickness = $strokeWidth
  $outline.StrokeLineJoin = [System.Windows.Media.PenLineJoin]::Round
  $fill = New-Object System.Windows.Shapes.Path
  $fill.Data = $geometry
  $fill.Fill = [System.Windows.Media.Brushes]::White
  $grid = New-Object System.Windows.Controls.Grid
  [void]$grid.Children.Add($outline)
  [void]$grid.Children.Add($fill)

  $width = $formatted.WidthIncludingTrailingWhitespace + $strokeWidth
  $now = [DateTime]::UtcNow
  $lane = 0
  $earliest = [DateTime]::MaxValue
  for ($i = 0; $i -lt $m.LaneCount; $i++) {
    $freeAt = if ($State.Lanes.ContainsKey($i)) { $State.Lanes[$i] } else { [DateTime]::MinValue }
    if ($freeAt -le $now) { $lane = $i; break }
    if ($freeAt -lt $earliest) { $earliest = $freeAt; $lane = $i }
  }
  $gap = $m.FontSize * 1.2
  $State.Lanes[$lane] = $now.AddMilliseconds((($width + $gap) / $m.Speed) * 1000)

  $y = 8 + $lane * $m.LaneHeight
  $duration = (($m.W + $width) / $m.Speed) * 1000
  $move = New-Object System.Windows.Media.TranslateTransform ($m.W, $y)
  $grid.RenderTransform = $move
  [void]$Canvas.Children.Add($grid)
  $anim = New-Object System.Windows.Media.Animation.DoubleAnimation ($m.W, (-$width), (New-Object System.Windows.Duration ([TimeSpan]::FromMilliseconds($duration))))
  $move.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, $anim)
  Add-Item $grid $duration 'comment'
}

# ------------------------------------------------------------------ reactions

function Get-NotoNames([string]$Emoji) {
  $cps = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $Emoji.Length; $i++) {
    $cp = [char]::ConvertToUtf32($Emoji, $i)
    if ($cp -gt 0xFFFF) { $i++ }
    $cps.Add(('{0:x}' -f $cp))
  }
  $full = $cps -join '_'
  $bare = ($cps | Where-Object { $_ -ne 'fe0f' }) -join '_'
  if ($full -eq $bare) { return @($full) }
  return @($full, $bare)
}

function Get-GifMeta($Metadata, [string]$Query, $Default) {
  try {
    $v = $Metadata.GetQuery($Query)
    if ($null -ne $v) { return $v }
  } catch { }
  return $Default
}

# Decodes an animated GIF into full frames at `Size` (GIF frames are partial and must be layered).
function ConvertTo-EmojiAnimation([byte[]]$Bytes, [double]$Size) {
  $stream = New-Object System.IO.MemoryStream (, $Bytes)
  $decoder = New-Object System.Windows.Media.Imaging.GifBitmapDecoder ($stream,
    [System.Windows.Media.Imaging.BitmapCreateOptions]::None, [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
  if ($decoder.Frames.Count -lt 1) { return $null }
  $globalMeta = $null
  try { $globalMeta = $decoder.Metadata } catch { }
  $logical = [double]$decoder.Frames[0].PixelWidth
  if ($null -ne $globalMeta) { $logical = [double](Get-GifMeta $globalMeta '/logscrdesc/Width' $logical) }
  if ($logical -le 0) { $logical = 512 }
  $scale = $Size / $logical
  $ppd = [double]$State.PixelsPerDip
  $pixels = [int][Math]::Ceiling($Size * $ppd)
  $fullRect = New-Object System.Windows.Rect (0, 0, $Size, $Size)

  $animation = New-Object System.Windows.Media.Animation.ObjectAnimationUsingKeyFrames
  $base = $null      # what the canvas looks like before the current frame: @{ Image; Hole }
  $elapsed = 0
  $first = $null
  foreach ($frame in $decoder.Frames) {
    $meta = $frame.Metadata
    $left = [double](Get-GifMeta $meta '/imgdesc/Left' 0)
    $top = [double](Get-GifMeta $meta '/imgdesc/Top' 0)
    $delay = [int](Get-GifMeta $meta '/grctlext/Delay' 10)
    if ($delay -lt 2) { $delay = 10 }
    $disposal = [int](Get-GifMeta $meta '/grctlext/Disposal' 0)
    $rect = New-Object System.Windows.Rect ($left * $scale, $top * $scale, $frame.PixelWidth * $scale, $frame.PixelHeight * $scale)

    $visual = New-Object System.Windows.Media.DrawingVisual
    $dc = $visual.RenderOpen()
    if ($null -ne $base) {
      if ($null -ne $base.Hole) {
        $clip = New-Object System.Windows.Media.CombinedGeometry ([System.Windows.Media.GeometryCombineMode]::Exclude,
          (New-Object System.Windows.Media.RectangleGeometry $fullRect), (New-Object System.Windows.Media.RectangleGeometry $base.Hole))
        $dc.PushClip($clip)
        $dc.DrawImage($base.Image, $fullRect)
        $dc.Pop()
      } else {
        $dc.DrawImage($base.Image, $fullRect)
      }
    }
    $dc.DrawImage($frame, $rect)
    $dc.Close()
    $bitmap = New-Object System.Windows.Media.Imaging.RenderTargetBitmap ($pixels, $pixels, (96.0 * $ppd), (96.0 * $ppd), [System.Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($visual)
    $bitmap.Freeze()
    if ($null -eq $first) { $first = $bitmap }

    $key = New-Object System.Windows.Media.Animation.DiscreteObjectKeyFrame ($bitmap, [System.Windows.Media.Animation.KeyTime]::FromTimeSpan([TimeSpan]::FromMilliseconds($elapsed)))
    [void]$animation.KeyFrames.Add($key)
    $elapsed += $delay * 10

    switch ($disposal) {
      2 { $base = @{ Image = $bitmap; Hole = $rect } }   # restore to background: clear this frame's area
      3 { }                                              # restore to previous: keep the old base
      default { $base = @{ Image = $bitmap; Hole = $null } }
    }
  }
  $animation.Duration = New-Object System.Windows.Duration ([TimeSpan]::FromMilliseconds([Math]::Max($elapsed, 100)))
  $animation.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  $animation.Freeze()
  return @{ Kind = 'gif'; First = $first; Animation = $animation }
}

function Get-ReactionSize {
  return [double]$Settings.ReactionSize
}

# Downloads run asynchronously; WebClient raises the completed event back on this (UI) thread.
function Request-EmojiImage([string]$Emoji) {
  if ($State.Emoji.ContainsKey($Emoji) -or $State.Downloads.ContainsKey($Emoji)) { return }
  $State.Downloads[$Emoji] = $true
  $attempts = New-Object System.Collections.ArrayList
  foreach ($name in (Get-NotoNames $Emoji)) { [void]$attempts.Add(@{ Kind = 'gif'; Url = "$AnimatedBase$name/512.gif" }) }
  foreach ($name in (Get-NotoNames $Emoji)) { [void]$attempts.Add(@{ Kind = 'png'; Url = "$AnimatedBase$name/512.png" }) }
  Start-EmojiDownload @{ Emoji = $Emoji; Attempts = $attempts; Index = 0 }
}

function Start-EmojiDownload($Job) {
  if ($Job.Index -ge $Job.Attempts.Count) {
    $State.Emoji[$Job.Emoji] = @{ Kind = 'none' }
    $State.Downloads.Remove($Job.Emoji)
    return
  }
  $client = New-Object System.Net.WebClient
  $client.Add_DownloadDataCompleted({
    param($sender, $e)
    $job = $e.UserState
    $sender.Dispose()
    $result = $null
    if (-not $e.Error -and -not $e.Cancelled) {
      $attempt = $job.Attempts[$job.Index]
      try {
        if ($attempt.Kind -eq 'gif') {
          $result = ConvertTo-EmojiAnimation $e.Result (Get-ReactionSize)
        } else {
          $image = New-Object System.Windows.Media.Imaging.BitmapImage
          $image.BeginInit()
          $image.StreamSource = New-Object System.IO.MemoryStream (, $e.Result)
          $image.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
          $image.EndInit()
          $image.Freeze()
          $result = @{ Kind = 'png'; Image = $image }
        }
      } catch {
        Write-Log ("絵文字画像を読めませんでした ({0}): {1}" -f $attempt.Url, $_.Exception.Message)
      }
    }
    if ($null -ne $result) {
      $State.Emoji[$job.Emoji] = $result
      $State.Downloads.Remove($job.Emoji)
    } else {
      $job.Index++
      Start-EmojiDownload $job
    }
  })
  $client.DownloadDataAsync([Uri]$Job.Attempts[$Job.Index].Url, $Job)
}

function New-ReactionVisual([string]$Emoji, [double]$Size, [bool]$Simple = $false) {
  $cached = $State.Emoji[$Emoji]
  if ($null -eq $cached) { Request-EmojiImage $Emoji }
  if ($null -ne $cached -and $cached.Kind -eq 'gif') {
    $img = New-Object System.Windows.Controls.Image
    $img.Width = $Size; $img.Height = $Size
    $img.Source = $cached.First
    if (-not $Simple) { $img.BeginAnimation([System.Windows.Controls.Image]::SourceProperty, $cached.Animation) }
    return $img
  }
  if ($null -ne $cached -and $cached.Kind -eq 'png') {
    $img = New-Object System.Windows.Controls.Image
    $img.Width = $Size; $img.Height = $Size
    $img.Source = $cached.Image
    return $img
  }
  # Not downloaded (yet): the emoji font. WPF draws it in one colour, so tint it warmly.
  $text = New-Object System.Windows.Controls.TextBlock
  $text.Text = $Emoji
  $text.FontFamily = New-Object System.Windows.Media.FontFamily 'Segoe UI Emoji'
  $text.FontSize = $Size * 0.85
  $text.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(255, 204, 77))
  $text.Width = $Size; $text.Height = $Size
  $text.TextAlignment = [System.Windows.TextAlignment]::Center
  return $text
}

function Add-Reaction([string]$Emoji, [bool]$Simple = $false) {
  $m = Get-Metrics
  $size = if ($Simple) { [double]$Settings.ReactionSizeBusy } else { [double]$Settings.ReactionSize }
  $element = New-ReactionVisual $Emoji $size $Simple
  $rnd = $State.Random

  # Straight up from near the bottom, like Meet.
  $x = $m.W * (0.04 + $rnd.NextDouble() * 0.92) - $size / 2
  $y0 = $m.H - $size - [Math]::Min(160, $m.H * 0.15)
  $rise = $Settings.ReactionSpeed * $Settings.ReactionMs / 1000.0
  $duration = [double]$Settings.ReactionMs

  $move = New-Object System.Windows.Media.TranslateTransform ($x, $y0)
  $element.RenderTransform = $move
  [void]$Canvas.Children.Add($element)

  $up = New-Object System.Windows.Media.Animation.DoubleAnimation ($y0, ($y0 - $rise), (New-Object System.Windows.Duration ([TimeSpan]::FromMilliseconds($duration))))
  $move.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $up)
  $fade = New-Object System.Windows.Media.Animation.DoubleAnimationUsingKeyFrames
  $fade.Duration = New-Object System.Windows.Duration ([TimeSpan]::FromMilliseconds($duration))
  foreach ($k in @(@(0, 1), @($Settings.ReactionFadeFrom, 1), @(1, 0))) {
    [void]$fade.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame ([double]$k[1], [System.Windows.Media.Animation.KeyTime]::FromPercent([double]$k[0]))))
  }
  $element.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fade)
  Add-Item $element $duration 'reaction'
}

# Reactions are collected for a moment and then released one by one: each reaction is always
# drawn as its own emoji. A burst is spread over a short time so they do not overlap.
function Invoke-ReactionFlush {
  if ($State.Pending.Count -eq 0) { return }
  $batch = @($State.Pending.GetEnumerator() | ForEach-Object { @{ Emoji = $_.Key; Count = [int]$_.Value } })
  $State.Pending.Clear()
  $now = [DateTime]::UtcNow
  foreach ($b in $batch) {
    $gap = [Math]::Min(70, 600 / $b.Count)
    for ($i = 0; $i -lt $b.Count; $i++) { [void]$PendingReactions.Add(@{ Emoji = $b.Emoji; At = $now.AddMilliseconds($gap * $i) }) }
  }
}

# ------------------------------------------------------------------ events

$PendingReactions = New-Object System.Collections.ArrayList   # @{ Emoji; At } waiting to be drawn

function Invoke-Events($Events) {
  $accepted = 0
  foreach ($e in @($Events)) {
    if ($null -eq $e) { continue }
    if ($e.type -eq 'comment' -and $e.text -is [string] -and $e.text.Trim()) {
      $State.Counts.comments++
      $accepted++
      if (-not $State.Paused) {
        $scale = 0.0; $secs = 0.0
        try { if ($null -ne $e.fontScale) { $scale = [double]$e.fontScale } } catch { }
        try { if ($null -ne $e.seconds) { $secs = [double]$e.seconds } } catch { }
        Add-Comment $e.text ([string]$e.author) $scale $secs
      }
    } elseif ($e.type -eq 'reaction' -and $e.emoji -is [string] -and $e.emoji.Trim()) {
      $State.Counts.reactions++
      $accepted++
      if (-not $State.Paused) {
        $count = 1
        if ($e.count -is [int] -or $e.count -is [long] -or $e.count -is [double]) { $count = [int][Math]::Min(50, [Math]::Max(1, $e.count)) }
        $emoji = $e.emoji.Trim()
        if ($emoji.Length -le 16) {
          if ($State.Pending.ContainsKey($emoji)) { $State.Pending[$emoji] += $count } else { $State.Pending[$emoji] = $count }
        }
      }
    }
  }
  return $accepted
}

function Invoke-TestEvents {
  [void](Invoke-Events @(
    [pscustomobject]@{ type = 'comment'; text = ('テストコメント ' + (Get-Date).ToString('HH:mm:ss')) },
    [pscustomobject]@{ type = 'reaction'; emoji = '👏'; count = 3 },
    [pscustomobject]@{ type = 'reaction'; emoji = '💖' },
    [pscustomobject]@{ type = 'reaction'; emoji = '😂' }
  ))
}

# ------------------------------------------------------------------ HTTP (tiny, loopback only)

$Latin1 = [System.Text.Encoding]::GetEncoding(28591)
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Send-Response($Conn, [int]$Status, [string]$ContentType, [byte[]]$Body) {
  if ($null -eq $Body) { $Body = New-Object byte[] 0 }
  $reason = switch ($Status) { 200 { 'OK' } 204 { 'No Content' } 400 { 'Bad Request' } 403 { 'Forbidden' } 404 { 'Not Found' } 413 { 'Payload Too Large' } default { 'OK' } }
  $head = "HTTP/1.1 $Status $reason`r`n" +
    "Cache-Control: no-store`r`n" +
    "Connection: close`r`n" +
    "Content-Length: $($Body.Length)`r`n"
  if ($ContentType) { $head += "Content-Type: $ContentType`r`n" }
  $head += "`r`n"
  $headBytes = [System.Text.Encoding]::ASCII.GetBytes($head)
  $Conn.Stream.Write($headBytes, 0, $headBytes.Length)
  if ($Body.Length -gt 0) { $Conn.Stream.Write($Body, 0, $Body.Length) }
  $Conn.Stream.Flush()
}

function Send-Json($Conn, [int]$Status, $Object) {
  Send-Response $Conn $Status 'application/json' ($Utf8.GetBytes(($Object | ConvertTo-Json -Compress -Depth 5)))
}

function Find-HeaderEnd([byte[]]$Bytes) {
  for ($i = 0; $i -le $Bytes.Length - 4; $i++) {
    if ($Bytes[$i] -eq 13 -and $Bytes[$i + 1] -eq 10 -and $Bytes[$i + 2] -eq 13 -and $Bytes[$i + 3] -eq 10) { return $i }
  }
  return -1
}

# Returns $true once the request has been answered.
function Invoke-Request($Conn) {
  $bytes = $Conn.Buffer.ToArray()
  $headerEnd = Find-HeaderEnd $bytes
  if ($headerEnd -lt 0) {
    if ($bytes.Length -gt 16384) { Send-Response $Conn 413 'text/plain' $null; return $true }
    return $false
  }
  $lines = $Latin1.GetString($bytes, 0, $headerEnd) -split "`r`n"
  $parts = $lines[0] -split ' '
  $method = $parts[0]
  $path = if ($parts.Length -gt 1) { ($parts[1] -split '\?')[0] } else { '/' }
  $length = 0
  $origin = ''
  foreach ($line in $lines) {
    if ($line -match '^(?i)content-length:\s*(\d+)') { $length = [int]$Matches[1] }
    if ($line -match '^(?i)origin:\s*(.*)$') { $origin = $Matches[1].Trim() }
  }
  # This server only listens on 127.0.0.1. Web pages open in a browser on this PC could still
  # reach it, so requests that carry an Origin are refused unless they come from a browser
  # extension or from this server's own test page. No CORS headers are sent either.
  if ($origin -and $origin -notmatch '^(chrome|moz|safari-web)-extension://' -and $origin -ne "http://127.0.0.1:$Port" -and $origin -ne "http://localhost:$Port") {
    Send-Response $Conn 403 'text/plain' ($Utf8.GetBytes('forbidden'))
    return $true
  }
  if ($length -gt 262144) { Send-Response $Conn 413 'text/plain' $null; return $true }
  $bodyStart = $headerEnd + 4
  if ($bytes.Length -lt $bodyStart + $length) { return $false }
  $body = if ($length -gt 0) { $Utf8.GetString($bytes, $bodyStart, $length) } else { '' }

  if ($method -eq 'OPTIONS') { Send-Response $Conn 204 $null $null; return $true }
  if ($method -eq 'GET' -and $path -eq '/ping') {
    Send-Json $Conn 200 @{ ok = $true; app = 'meet-comment-overlay'; paused = $State.Paused; counts = $State.Counts }
    return $true
  }
  if ($method -eq 'GET' -and ($path -eq '/' -or $path -eq '/test' -or $path -eq '/test.html')) {
    $file = Join-Path $PSScriptRoot 'test.html'
    if (Test-Path $file) { Send-Response $Conn 200 'text/html; charset=utf-8' ([System.IO.File]::ReadAllBytes($file)) }
    else { Send-Response $Conn 404 'text/plain' ($Utf8.GetBytes('test.html not found')) }
    return $true
  }
  if ($method -eq 'GET' -and $path -eq '/screens') {
    Send-Json $Conn 200 @{ ok = $true; screens = (Get-ScreenList); current = $script:ScreenIndex; allowAll = $false }
    return $true
  }
  if ($method -eq 'POST' -and $path -eq '/screen') {
    $index = $null
    try { $index = (ConvertFrom-Json -InputObject $body).index } catch { }
    if ($null -eq $index -or $index -lt 0 -or $index -ge [System.Windows.Forms.Screen]::AllScreens.Length) {
      Send-Json $Conn 400 @{ ok = $false; error = 'invalid screen' }
      return $true
    }
    Set-OverlayScreen ([int]$index)
    Save-OverlaySettings
    Send-Json $Conn 200 @{ ok = $true; screens = (Get-ScreenList); current = $script:ScreenIndex; allowAll = $false }
    return $true
  }
  if ($method -eq 'GET' -and $path -eq '/debug') {
    $emoji = @{}
    foreach ($k in $State.Emoji.Keys) { $emoji[$k] = $State.Emoji[$k].Kind }
    Send-Json $Conn 200 @{
      paused = $State.Paused; counts = $State.Counts; live = $State.Items.Count
      window = @{ left = $Window.Left; top = $Window.Top; width = $Window.ActualWidth; height = $Window.ActualHeight; dpiScale = $dpiScale; pixelsPerDip = $State.PixelsPerDip }
      emoji = $emoji; downloading = @($State.Downloads.Keys)
    }
    return $true
  }
  if ($method -eq 'POST' -and $path -eq '/event') {
    try {
      $events = ConvertFrom-Json -InputObject $body
    } catch {
      Send-Json $Conn 400 @{ ok = $false; error = 'invalid JSON' }
      return $true
    }
    $accepted = Invoke-Events $events
    Send-Json $Conn 200 @{ ok = $true; accepted = $accepted; paused = $State.Paused }
    return $true
  }
  Send-Response $Conn 404 'text/plain' ($Utf8.GetBytes('not found'))
  return $true
}

# Polled from the UI timer and never blocks: animations keep running while requests come in.
function Invoke-ServerTick {
  while ($State.Listener.Pending()) {
    $client = $State.Listener.AcceptTcpClient()
    $client.NoDelay = $true
    [void]$State.Clients.Add(@{ Client = $client; Stream = $client.GetStream(); Buffer = (New-Object System.IO.MemoryStream); Since = [DateTime]::UtcNow })
  }
  for ($i = $State.Clients.Count - 1; $i -ge 0; $i--) {
    $conn = $State.Clients[$i]
    $done = $false
    try {
      while ($conn.Stream.DataAvailable) {
        $n = $conn.Stream.Read($State.ReadBuffer, 0, $State.ReadBuffer.Length)
        if ($n -le 0) { $done = $true; break }
        $conn.Buffer.Write($State.ReadBuffer, 0, $n)
      }
      if (-not $done -and $conn.Buffer.Length -gt 0) { $done = Invoke-Request $conn }
      if (-not $done -and ([DateTime]::UtcNow - $conn.Since).TotalSeconds -gt 5) { $done = $true }
    } catch {
      Write-Log ('通信エラー: ' + $_.Exception.Message)
      $done = $true
    }
    if ($done) {
      try { $conn.Client.Close() } catch { }
      $State.Clients.RemoveAt($i)
    }
  }
}

function Test-AlreadyRunning {
  try {
    $probe = New-Object System.Net.WebClient
    $answer = $probe.DownloadString("http://127.0.0.1:$Port/ping")
    $probe.Dispose()
    return $answer -like '*meet-comment-overlay*'
  } catch {
    return $false
  }
}

function Start-Server {
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
      $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback, $Port)
      $listener.Start()
      $State.Listener = $listener
      return $true
    } catch {
      if ($attempt -eq 0) { Write-Log "ポート $Port が使用中です。空くのを待っています…（別のオーバーレイが起動中ならそちらを終了してください）" }
      Start-Sleep -Milliseconds 1500
    }
  }
  return $false
}

# ------------------------------------------------------------------ tray icon

$Notify = New-Object System.Windows.Forms.NotifyIcon
$Notify.Icon = [System.Drawing.SystemIcons]::Information
try {
  # the extension's icon (a screen with a speech bubble), when it is next to this folder
  $iconFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'extension\icons\icon32.png'
  if (Test-Path $iconFile) {
    $iconBitmap = New-Object System.Drawing.Bitmap $iconFile
    $Notify.Icon = [System.Drawing.Icon]::FromHandle($iconBitmap.GetHicon())
  }
} catch { }
$Notify.Text = "Meet Comment Overlay (port $Port)"
$Menu = New-Object System.Windows.Forms.ContextMenuStrip
$MenuTest = $Menu.Items.Add('テストコメントを流す')
$MenuTest.Add_Click({ Invoke-TestEvents })
$MenuPage = $Menu.Items.Add('テスト送信ページを開く')
$MenuPage.Add_Click({ Start-Process "http://127.0.0.1:$Port/" })
$MenuPause = $Menu.Items.Add('一時停止')
$MenuPause.Add_Click({
  $State.Paused = -not $State.Paused
  $MenuPause.Checked = $State.Paused
  if ($State.Paused) {
    $Canvas.Children.Clear()
    $State.Items.Clear()
    $Window.Visibility = [System.Windows.Visibility]::Hidden
  } else {
    $Window.Visibility = [System.Windows.Visibility]::Visible
  }
})
[void]$Menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$MenuQuit = $Menu.Items.Add('終了')
$MenuQuit.Add_Click({ $App.Shutdown() })
$Notify.ContextMenuStrip = $Menu

# ------------------------------------------------------------------ main loop

$Timer = New-Object System.Windows.Threading.DispatcherTimer
$Timer.Interval = [TimeSpan]::FromMilliseconds(30)
$Timer.Add_Tick({
  try {
    $State.Tick++
    if ($State.Tick -eq 2) {
      foreach ($e in $DefaultReactions) { Request-EmojiImage $e }   # fetch Meet's standard reactions early
    }
    Invoke-ServerTick
    if ($State.Tick % 5 -eq 0) { Invoke-ReactionFlush }

    $now = [DateTime]::UtcNow
    for ($i = $PendingReactions.Count - 1; $i -ge 0; $i--) {
      if ($PendingReactions[$i].At -le $now) {
        $p = $PendingReactions[$i]
        $PendingReactions.RemoveAt($i)
        if (-not $State.Paused) {
          $busy = (Get-LiveCount 'reaction') -ge $Settings.BusyReactions
          Add-Reaction $p.Emoji $busy
        }
      }
    }
    if ($State.Tick % 8 -eq 0) {
      for ($i = $State.Items.Count - 1; $i -ge 0; $i--) {
        if ($State.Items[$i].EndsAt -le $now) {
          $Canvas.Children.Remove($State.Items[$i].Element)
          $State.Items.RemoveAt($i)
        }
      }
    }
    if ($State.Tick % 66 -eq 0 -and $State.Hwnd -ne [IntPtr]::Zero -and -not $State.Paused) {
      [MeetOverlay.Native]::KeepOnTop($State.Hwnd)
    }
  } catch {
    Write-Log ('エラー: ' + $_.Exception.Message)
  }
})

if (Test-AlreadyRunning) {
  [void][System.Windows.MessageBox]::Show("オーバーレイはすでに起動しています（ポート $Port）。タスクトレイのアイコンから操作してください。", 'Meet Comment Overlay')
  exit 0
}
if (-not (Start-Server)) {
  [void][System.Windows.MessageBox]::Show("ポート $Port を開けませんでした。オーバーレイがすでに起動していないか確認してください。", 'Meet Comment Overlay')
  exit 1
}

$App = New-Object System.Windows.Application
$App.ShutdownMode = [System.Windows.ShutdownMode]::OnExplicitShutdown
$Window.Show()
$Notify.Visible = $true
$Notify.ShowBalloonTip(3000, 'Meet Comment Overlay', "起動しました（ポート $Port）。終了はこのアイコンを右クリック → 終了", [System.Windows.Forms.ToolTipIcon]::Info)
$Timer.Start()
Write-Log "起動しました: http://127.0.0.1:$Port/  (画面 $($targetScreen.DeviceName), $($bounds.Width)x$($bounds.Height), 拡大率 $dpiScale)"
Write-Log '終了するにはタスクトレイのアイコンを右クリック → 終了'

try {
  [void]$App.Run()
} finally {
  $Timer.Stop()
  $Notify.Visible = $false
  $Notify.Dispose()
  foreach ($c in $State.Clients) { try { $c.Client.Close() } catch { } }
  if ($State.Listener) { $State.Listener.Stop() }
}
