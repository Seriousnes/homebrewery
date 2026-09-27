using System.Net;
using System.Net.Sockets;

namespace Homebrewery.Api.Pdf;

/// <summary>
/// Which IP addresses the PDF renderer may fetch other sites' files from: public unicast addresses only. Loopback,
/// private, link-local (cloud metadata), shared (CGNAT), documentation, benchmark, multicast and reserved ranges are
/// refused. IPv4-mapped and 6to4 addresses are judged by their IPv4 address; NAT64 and Teredo addresses are refused.
/// </summary>
public static class PublicAddress
{
    // IPv4 ranges that are not public (RFC 6890 special-purpose registry, plus multicast and reserved).
    private static readonly (uint Network, int Prefix)[] BlockedV4 =
    [
        (0x00000000, 8),    // 0.0.0.0/8       "this network"
        (0x0A000000, 8),    // 10.0.0.0/8      private
        (0x64400000, 10),   // 100.64.0.0/10   shared address space (CGNAT)
        (0x7F000000, 8),    // 127.0.0.0/8     loopback
        (0xA9FE0000, 16),   // 169.254.0.0/16  link-local (cloud metadata endpoints)
        (0xAC100000, 12),   // 172.16.0.0/12   private
        (0xC0000000, 24),   // 192.0.0.0/24    IETF protocol assignments
        (0xC0000200, 24),   // 192.0.2.0/24    TEST-NET-1
        (0xC0586300, 24),   // 192.88.99.0/24  6to4 relay anycast
        (0xC0A80000, 16),   // 192.168.0.0/16  private
        (0xC6120000, 15),   // 198.18.0.0/15   benchmarking
        (0xC6336400, 24),   // 198.51.100.0/24 TEST-NET-2
        (0xCB007100, 24),   // 203.0.113.0/24  TEST-NET-3
        (0xE0000000, 4),    // 224.0.0.0/4     multicast
        (0xF0000000, 4),    // 240.0.0.0/4     reserved, and 255.255.255.255 broadcast
    ];

    /// <summary>True when <paramref name="address"/> is a public unicast address.</summary>
    public static bool IsPublic(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) return IsPublicV4(address.MapToIPv4());
        return address.AddressFamily switch
        {
            AddressFamily.InterNetwork => IsPublicV4(address),
            AddressFamily.InterNetworkV6 => IsPublicV6(address),
            _ => false,
        };
    }

    private static bool IsPublicV4(IPAddress address)
    {
        var bytes = address.GetAddressBytes();
        var value = (uint)(bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]);
        foreach (var (network, prefix) in BlockedV4)
        {
            var mask = uint.MaxValue << (32 - prefix);
            if ((value & mask) == network) return false;
        }
        return true;
    }

    private static bool IsPublicV6(IPAddress address)
    {
        var b = address.GetAddressBytes();

        // Only global unicast (2000::/3) is public; this also refuses ::, ::1, IPv4-compatible ::a.b.c.d, NAT64
        // 64:ff9b::/96, ULA fc00::/7, link-local fe80::/10, site-local fec0::/10 and multicast ff00::/8.
        if ((b[0] & 0xE0) != 0x20) return false;

        // 2001:db8::/32 documentation.
        if (b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x0D && b[3] == 0xB8) return false;
        // 2001::/23 IETF protocol assignments, including Teredo 2001::/32 (its IPv4 part is obfuscated).
        if (b[0] == 0x20 && b[1] == 0x01 && b[2] < 0x02) return false;
        // 2002::/16 6to4: the IPv4 address in bytes 2-5 must be public.
        if (b[0] == 0x20 && b[1] == 0x02) return IsPublicV4(new IPAddress(b[2..6]));
        return true;
    }
}
