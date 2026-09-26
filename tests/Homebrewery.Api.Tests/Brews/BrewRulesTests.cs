using System.Diagnostics;
using System.Text.Json;
using Homebrewery.Api.Brews;

namespace Homebrewery.Api.Tests.Brews;

/// <summary>BrewRules on inputs the endpoint tests don't cover: huge and malformed lists, unstorable numbers.</summary>
public sealed class BrewRulesTests
{
    private static readonly TimeSpan Quick = TimeSpan.FromSeconds(1);

    [Fact]
    public void A_huge_tag_list_is_rejected_quickly()
    {
        var tags = Enumerable.Range(0, 100_000).Select(i => $"t{i}").ToList();
        var errors = new Dictionary<string, string[]>();

        var watch = Stopwatch.StartNew();
        BrewRules.Merge(BrewRules.Defaults, new BrewMetaInput(Tags: tags), errors);
        watch.Stop();

        Assert.Equal([$"a brew has at most {BrewRules.MaxTags} tags"], errors["meta.tags"]);
        Assert.True(watch.Elapsed < Quick, $"took {watch.Elapsed}");
    }

    [Fact]
    public void A_huge_author_list_is_rejected_quickly()
    {
        var handles = Enumerable.Range(0, 100_000).Select(i => $"user-{i}").ToList();
        var errors = new Dictionary<string, string[]>();

        var watch = Stopwatch.StartNew();
        var result = BrewRules.NormalizeHandles(handles, errors);
        watch.Stop();

        Assert.Null(result);
        Assert.Equal([$"a brew has at most {BrewRules.MaxAuthors} authors"], errors["meta.authors"]);
        Assert.True(watch.Elapsed < Quick, $"took {watch.Elapsed}");
    }

    [Theory]
    [InlineData(100_000)]
    [InlineData(150)]
    public void Invalid_handles_give_one_error_not_one_per_handle(int count)
    {
        var handles = Enumerable.Range(0, count).Select(i => $"not a handle {i}").ToList();
        var errors = new Dictionary<string, string[]>();

        var watch = Stopwatch.StartNew();
        var result = BrewRules.NormalizeHandles(handles, errors);
        watch.Stop();

        Assert.Null(result);
        Assert.Single(errors["meta.authors"]);
        Assert.True(watch.Elapsed < Quick, $"took {watch.Elapsed}");
    }

    [Fact]
    public void Too_long_tags_give_one_error()
    {
        var tags = Enumerable.Range(0, 40).Select(i => new string('x', BrewRules.MaxTag + 1) + i).ToList();
        var errors = new Dictionary<string, string[]>();

        BrewRules.Merge(BrewRules.Defaults, new BrewMetaInput(Tags: tags), errors);

        Assert.Equal([$"tags must be at most {BrewRules.MaxTag} characters"], errors["meta.tags"]);
    }

    [Fact]
    public void Duplicates_and_blanks_do_not_count_toward_the_tag_limit()
    {
        // 60 entries that normalize to 50 distinct tags.
        var tags = Enumerable.Range(0, BrewRules.MaxTags).Select(i => $"t{i}").Concat(["t1", " t2 ", "", "  ", "t3", "t4", "t5", "t6", "t7", "t8"]).ToList();
        var errors = new Dictionary<string, string[]>();

        var meta = BrewRules.Merge(BrewRules.Defaults, new BrewMetaInput(Tags: tags), errors);

        Assert.Empty(errors);
        Assert.Equal(BrewRules.MaxTags, meta.Tags.Count);
    }

    [Fact]
    public void A_null_author_entry_is_a_validation_error()
    {
        var errors = new Dictionary<string, string[]>();

        var result = BrewRules.NormalizeHandles(["valid-handle", null!], errors);

        Assert.Null(result);
        Assert.Contains("meta.authors", errors.Keys);
    }

    [Fact]
    public void Snippet_numbers_are_stored_in_canonical_form()
    {
        using var snippets = JsonDocument.Parse("""[{"a":1e1001,"b":1e-20000,"c":1.50,"d":12,"e":1e308}]""");
        var errors = new Dictionary<string, string[]>();

        var stored = BrewRules.Snippets(snippets.RootElement, errors);

        Assert.Empty(errors);
        Assert.Equal("""[{"a":null,"b":0,"c":1.5,"d":12,"e":null}]""", stored);
    }
}
