using Homebrewery.Core.Documents;

namespace Homebrewery.Api.Tests.Documents;

/// <summary>CssPolicy (plan §8.5 rule 5): script-capable CSS is refused, ordinary CSS that only looks similar is not.</summary>
public sealed class CssPolicyTests
{
    [Theory]
    [InlineData("scroll-behavior: smooth;")]
    [InlineData("overscroll-behavior: contain;")]
    [InlineData("font-family: \"Expression (Bold)\";")]
    [InlineData("font-family: 'My Expression(1)', serif")]
    [InlineData("background-image: url(https://e.x/javascript:1.png);")]
    [InlineData("background-image: url('/img/vbscript:x.png')")]
    [InlineData("content: \"behavior: none\"")]
    [InlineData("color: red; --my-expression: 1")]
    public void Ordinary_css_is_accepted(string style)
    {
        Assert.Null(CssPolicy.Check(style));
    }

    [Theory]
    [InlineData("behavior:url(x.htc)")]
    [InlineData("color: red; behavior: url(x.htc)")]
    [InlineData("-ms-behavior: url(x.htc)")]
    [InlineData("_behavior: url(x.htc)")]
    [InlineData("width:expression(alert(1))")]
    [InlineData("width: EXPRESSION (alert(1))")]
    [InlineData("background:url(javascript:alert(1))")]
    [InlineData("background:url( javascript:alert(1))")]
    [InlineData("background:url(\"javascript:x\")")]
    [InlineData("background:url('vbscript:x')")]
    [InlineData("background:url(java\\73 cript:alert(1))")]
    [InlineData("java\\73 cript:")]
    [InlineData("expr/**/ession(")]
    [InlineData("width: expr\\65 ssion(alert(1))")]
    [InlineData("-moz-binding:url(x)")]
    [InlineData("width: \\\"; x: expression(alert(1)); y: \"")]        // an escaped quote does not start a string
    [InlineData("font-family: \"a\"; width: expression(alert(1))")]
    public void Script_capable_css_is_refused(string style)
    {
        Assert.NotNull(CssPolicy.Check(style));
    }
}
