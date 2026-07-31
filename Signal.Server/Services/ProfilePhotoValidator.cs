namespace Signal.Server.Services;

public static class ProfilePhotoValidator
{
    public const int RequiredDimension = 512;

    public const int MaximumBytes = 1_000_000;

    public static bool IsValidJpeg(ReadOnlySpan<byte> image)
    {
        if (image.Length < 11
            || image[0] != 0xff
            || image[1] != 0xd8
            || image[^2] != 0xff
            || image[^1] != 0xd9)
        {
            return false;
        }

        var offset = 2;
        while (offset + 3 < image.Length)
        {
            while (offset < image.Length && image[offset] != 0xff) offset++;
            while (offset < image.Length && image[offset] == 0xff) offset++;
            if (offset >= image.Length) return false;

            var marker = image[offset++];
            if (marker is 0xd8 or 0xd9 || marker is >= 0xd0 and <= 0xd7) continue;
            if (marker == 0xda) return false;
            if (offset + 1 >= image.Length) return false;

            var segmentLength = (image[offset] << 8) | image[offset + 1];
            if (segmentLength < 2 || offset + segmentLength > image.Length) return false;

            if (IsStartOfFrame(marker))
            {
                if (segmentLength < 7) return false;
                var height = (image[offset + 3] << 8) | image[offset + 4];
                var width = (image[offset + 5] << 8) | image[offset + 6];
                return width == RequiredDimension && height == RequiredDimension;
            }

            offset += segmentLength;
        }

        return false;
    }

    private static bool IsStartOfFrame(byte marker) =>
        marker is 0xc0 or 0xc1 or 0xc2 or 0xc3
            or 0xc5 or 0xc6 or 0xc7
            or 0xc9 or 0xca or 0xcb
            or 0xcd or 0xce or 0xcf;
}
