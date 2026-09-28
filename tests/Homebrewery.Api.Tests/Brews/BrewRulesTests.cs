using System.Text.Json;
using Homebrewery.Api.Brews;

namespace Homebrewery.Api.Tests.Brews;

/// <summary>BrewRules on inputs the endpoint tests don't cover: huge and malformed lists, unstorable numbers.</summary>
public sealed class BrewRulesTests
{
    [Fact]
    public void A_huge_tag_list_is_rejected_without_reading_it()
    {
        var tags = new CountingList<string>([.. Enumerable.Range(0, 100_000).Select(i => $"t{i}")]);
        var errors = new Dictionary<string, string[]>();

        BrewRules.Merge(BrewRules.Defaults, new BrewMetaInput(Tags: tags), errors);

        Assert.Equal([$"a brew has at most {BrewRules.MaxTags} tags"], errors["meta.tags"]);
        Assert.Equal(0, tags.Reads);
    }

    [Fact]
    public void A_huge_author_list_is_rejected_without_reading_it()
    {
        var handles = new CountingList<string>([.. Enumerable.Range(0, 100_000).Select(i => $"user-{i}")]);
        var errors = new Dictionary<string, string[]>();

        var result = BrewRules.NormalizeHandles(handles, errors);

        Assert.Null(result);
        Assert.Equal([$"a brew has at most {BrewRules.MaxAuthors} authors"], errors["meta.authors"]);
        Assert.Equal(0, handles.Reads);
    }

    [Theory]
    [InlineData(100_000, 0)]                                     // refused by its length
    [InlineData(150, 1)]                                         // stops at the first invalid handle
    public void Invalid_handles_give_one_error_not_one_per_handle(int count, int reads)
    {
        var handles = new CountingList<string>([.. Enumerable.Range(0, count).Select(i => $"not a handle {i}")]);
        var errors = new Dictionary<string, string[]>();

        var result = BrewRules.NormalizeHandles(handles, errors);

        Assert.Null(result);
        Assert.Single(errors["meta.authors"]);
        Assert.Equal(reads, handles.Reads);
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

    /// <summary>A list that counts how many of its items were read (by index or enumeration).</summary>
    private sealed class CountingList<T>(IReadOnlyList<T> items) : IReadOnlyList<T>
    {
        public int Reads { get; private set; }

        public int Count => items.Count;

        public T this[int index]
        {
            get
            {
                Reads++;
                return items[index];
            }
        }

        public IEnumerator<T> GetEnumerator()
        {
            foreach (var item in items)
            {
                Reads++;
                yield return item;
            }
        }

        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }
}