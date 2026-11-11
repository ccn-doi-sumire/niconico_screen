import AppKit
import CoreGraphics

// Draws the extension icon (a screen with a speech bubble on it) at several sizes.
// Coordinates are in a 128 x 128 design space with the origin at the top left.
func color(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: a)
}
func rounded(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r: CGFloat) -> CGPath {
  CGPath(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerWidth: r, cornerHeight: r, transform: nil)
}

func draw(size: Int, to path: String) {
  let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.interpolationQuality = .high
  ctx.setShouldAntialias(true)
  let s = CGFloat(size) / 128
  ctx.translateBy(x: 0, y: CGFloat(size))
  ctx.scaleBy(x: s, y: -s) // y grows downwards from here on

  let small = size <= 32 // fewer details and bigger shapes so it still reads at 16 px
  let blueTop = color(0x4285f4), blueBottom = color(0x1a56db), ink = color(0x1a56db)

  // background tile
  let tile = small ? rounded(0, 0, 128, 128, 28) : rounded(6, 6, 116, 116, 28)
  ctx.saveGState()
  ctx.addPath(tile)
  ctx.clip()
  let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!, colors: [blueTop, blueBottom] as CFArray, locations: [0, 1])!
  ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: 128), options: [])
  ctx.restoreGState()

  // screen + stand, white
  let m: (x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat, r: CGFloat) = small ? (14, 24, 100, 64, 10) : (24, 30, 80, 54, 9)
  ctx.setFillColor(color(0xffffff))
  ctx.addPath(rounded(m.x, m.y, m.w, m.h, m.r))
  ctx.fillPath()
  let cx = m.x + m.w / 2
  let neckW: CGFloat = small ? 14 : 10, neckH: CGFloat = small ? 10 : 9
  ctx.fill(CGRect(x: cx - neckW / 2, y: m.y + m.h - 1, width: neckW, height: neckH + 1))
  let baseW: CGFloat = small ? 52 : 40, baseH: CGFloat = small ? 9 : 7
  ctx.addPath(rounded(cx - baseW / 2, m.y + m.h + neckH - 1, baseW, baseH, baseH / 2))
  ctx.fillPath()

  // speech bubble on the screen
  let bw = m.w * 0.56, bh = m.h * 0.46
  let bx = cx - bw / 2, by = m.y + m.h * 0.17
  ctx.setFillColor(ink)
  ctx.addPath(rounded(bx, by, bw, bh, bh * 0.28))
  ctx.fillPath()
  let tail = CGMutablePath()
  tail.move(to: CGPoint(x: bx + bw * 0.16, y: by + bh - 1))
  tail.addLine(to: CGPoint(x: bx + bw * 0.16, y: by + bh + m.h * 0.2))
  tail.addLine(to: CGPoint(x: bx + bw * 0.44, y: by + bh - 1))
  tail.closeSubpath()
  ctx.addPath(tail)
  ctx.fillPath()

  if !small { // three dots: "someone is commenting"
    ctx.setFillColor(color(0xffffff))
    let r: CGFloat = 3.4
    for i in -1...1 {
      ctx.fillEllipse(in: CGRect(x: cx + CGFloat(i) * 11 - r, y: by + bh / 2 - r, width: r * 2, height: r * 2))
    }
  }

  let image = ctx.makeImage()!
  let rep = NSBitmapImageRep(cgImage: image)
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

// Usage: swiftc -O tools/make-icons.swift -o /tmp/make-icons && /tmp/make-icons extension/icons
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "extension/icons"
for size in [16, 32, 48, 128] { draw(size: size, to: "\(out)/icon\(size).png") }
