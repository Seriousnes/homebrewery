using System.Net;
using Homebrewery.Api.Pdf;

namespace Homebrewery.Api.Tests.Pdf;

/// <summary>The addresses PDF export may fetch other sites' files from (the SSRF guard's rule).</summary>
public sealed class PublicAddressTests
{
    [Theory]
    [InlineData("0.0.0.0")]
    [InlineData("10.1.2.3")]
    [InlineData("100.64.0.1")]              // CGNAT
    [InlineData("127.0.0.1")]
    [InlineData("127.255.255.254")]
    [InlineData("169.254.169.254")]         // cloud metadata
    [InlineData("172.16.0.1")]
    [InlineData("172.31.255.255")]
    [InlineData("192.0.0.8")]
    [InlineData("192.0.2.1")]
    [InlineData("192.168.1.1")]
    [InlineData("198.18.0.1")]
    [InlineData("198.51.100.7")]
    [InlineData("203.0.113.9")]
    [InlineData("224.0.0.1")]
    [InlineData("255.255.255.255")]
    [InlineData("::")]
    [InlineData("::1")]
    [InlineData("::ffff:127.0.0.1")]        // IPv4-mapped loopback
    [InlineData("::ffff:10.0.0.1")]
    [InlineData("::127.0.0.1")]             // IPv4-compatible (deprecated)
    [InlineData("64:ff9b::a9fe:a9fe")]      // NAT64 of 169.254.169.254
    [InlineData("fc00::1")]
    [InlineData("fd00:ec2::254")]           // AWS metadata over IPv6
    [InlineData("fe80::1")]
    [InlineData("fec0::1")]
    [InlineData("ff02::1")]
    [InlineData("2001:db8::1")]             // documentation
    [InlineData("2001:0:4136:e378:8000:63bf:3fff:fdd2")] // Teredo
    [InlineData("2002:7f00:1::1")]          // 6to4 of 127.0.0.1
    [InlineData("2002:a9fe:a9fe::1")]       // 6to4 of 169.254.169.254
    public void Non_public_addresses_are_refused(string address) =>
        Assert.False(PublicAddress.IsPublic(IPAddress.Parse(address)));

    [Theory]
    [InlineData("1.1.1.1")]
    [InlineData("8.8.8.8")]
    [InlineData("100.63.255.255")]          // just below CGNAT
    [InlineData("172.15.255.255")]          // just below 172.16/12
    [InlineData("172.32.0.1")]              // just above
    [InlineData("151.101.1.140")]
    [InlineData("::ffff:8.8.8.8")]
    [InlineData("2606:4700:4700::1111")]
    [InlineData("2a00:1450:4001:80b::200e")]
    [InlineData("2002:0808:0808::1")]       // 6to4 of 8.8.8.8
    public void Public_addresses_are_allowed(string address) =>
        Assert.True(PublicAddress.IsPublic(IPAddress.Parse(address)));
}
