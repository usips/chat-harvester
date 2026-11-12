Add-Type -AssemblyName System.Drawing

function New-RoundedRectanglePath {
    param(
        [int]$Size,
        [int]$Radius
    )

    $diameter = $Radius * 2
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
    $path.AddArc($Size - $diameter - 1, 0, $diameter, $diameter, 270, 90)
    $path.AddArc($Size - $diameter - 1, $Size - $diameter - 1, $diameter, $diameter, 0, 90)
    $path.AddArc(0, $Size - $diameter - 1, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

$iconRoot = Join-Path $PSScriptRoot '..\extension\icons'
foreach ($size in 16, 48, 128) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $radius = [Math]::Max(2, [Math]::Round($size / 8))
    $path = New-RoundedRectanglePath -Size $size -Radius $radius
    $background = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#4a90d9'))
    $graphics.FillPath($background, $path)

    $font = [System.Drawing.Font]::new('Arial', [single]($size * 0.59), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $foreground = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $format = [System.Drawing.StringFormat]::new()
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $bounds = [System.Drawing.RectangleF]::new(0, [single](-$size * 0.02), $size, $size)
    $graphics.DrawString('C', $font, $foreground, $bounds, $format)

    $outputPath = Join-Path $iconRoot "icon$size.png"
    $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)

    $format.Dispose()
    $foreground.Dispose()
    $font.Dispose()
    $background.Dispose()
    $path.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}
