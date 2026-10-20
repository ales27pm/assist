import Foundation
import ImageIO

@main
struct WeatherAttributionImageChecks {
    static func main() async throws {
        let sourceURL = "https://weatherkit.apple.com/assets/branding/en/Apple_Weather_blk_en_3X_090122.png"
        let request = AssistWeatherAttributionPolicy.Request(requestId: "fixture-mark", markURL: URL(string: sourceURL)!, appearance: "light")
        func png(width: Int, height: Int) throws -> Data {
            guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
                let image = context.makeImage() else { throw AssistWeatherAttributionPolicy.failure() }
            let encoded = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(encoded, "public.png" as CFString, 1, nil) else { throw AssistWeatherAttributionPolicy.failure() }
            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else { throw AssistWeatherAttributionPolicy.failure() }
            return encoded as Data
        }
        let asset = try AssistWeatherMarkLoader.decode(png(width: 231, height: 42), request: request)
        guard asset.width == 231, asset.height == 42, asset.sourceURL == sourceURL,
              asset.pngDataURI.hasPrefix("data:image/png;base64,iVBORw0KGgo"), asset.rendered else { throw AssistWeatherAttributionPolicy.failure() }
        var rejected = 0
        for invalid in [Data("<svg/>".utf8), Data(repeating: 0, count: 33 * 1_024), try png(width: 769, height: 1), try png(width: 600, height: 128)] {
            do { _ = try AssistWeatherMarkLoader.decode(invalid, request: request) }
            catch { rejected += 1 }
        }
        guard rejected == 4 else { throw AssistWeatherAttributionPolicy.failure() }
        print("PASS: 5 ImageIO PNG decode/reencode, unchanged aspect ratio and invalid/pixel-budget checks; fixture is not a branding replacement")
        if CommandLine.arguments.contains("--official-public-mark") {
            let json = try await AssistWeatherMarkLoader.load(request)
            let official = try JSONDecoder().decode(AssistWeatherAttributionPolicy.Asset.self, from: Data(json.utf8))
            guard official.width == 231, official.height == 42, official.sourceURL == sourceURL else { throw AssistWeatherAttributionPolicy.failure() }
            print("PASS: real public Apple mark fetched with native no-redirect transport and decoded/reencoded 231x42; macOS evidence only, no weather or iPhone qualification")
        }
    }
}
