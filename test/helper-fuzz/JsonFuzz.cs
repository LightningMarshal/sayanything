// Fuzz test for the Windows helper's hand-rolled JSON parser (WS-13).
// Built and run on Linux/macOS with Mono by scripts/fuzz-helper-json.sh; C# 5.
//
// The parser reads commands from the Electron main process over stdin. It must
// never throw an uncatchable exception (StackOverflowException kills the helper
// and with it the hotkey), never loop forever, and must parse the real
// protocol messages correctly. Exits non-zero on any failure.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Text;

static class JsonFuzz
{
    static Type _parserType;
    static int _failed = 0;
    static int _passed = 0;

    static object Parse(string s)
    {
        object p = Activator.CreateInstance(_parserType, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
            null, new object[] { s }, null);
        return _parserType.GetMethod("Parse", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).Invoke(p, null);
    }

    static void Check(bool ok, string label)
    {
        if (ok) _passed++;
        else { _failed++; Console.WriteLine("FAIL: " + label); }
    }

    // Parse within a time budget; any managed exception is a failure too.
    static object ParseSafely(string s, string label)
    {
        Stopwatch sw = Stopwatch.StartNew();
        object r = null;
        try { r = Parse(s); }
        catch (TargetInvocationException ex) { Check(false, label + ": threw " + ex.InnerException.GetType().Name); return null; }
        Check(sw.ElapsedMilliseconds < 2000, label + ": finished in " + sw.ElapsedMilliseconds + " ms");
        return r;
    }

    static int Main()
    {
        Assembly asm = typeof(JsonFuzz).Assembly;
        Type helper = asm.GetType("SayAnythingHelper");
        _parserType = helper.GetNestedType("JsonParser", BindingFlags.NonPublic | BindingFlags.Public);
        if (_parserType == null) { Console.WriteLine("FAIL: JsonParser not found"); return 1; }

        // 1. Real protocol messages parse correctly.
        Dictionary<string, object> d = Parse("{\"cmd\":\"paste\",\"text\":\"h\\u00e9llo \\\"x\\\"\\n\",\"restoreMs\":300}") as Dictionary<string, object>;
        Check(d != null && (string)d["cmd"] == "paste", "paste: cmd");
        Check(d != null && (string)d["text"] == "h\u00e9llo \"x\"\n", "paste: escapes decoded");
        Check(d != null && (double)d["restoreMs"] == 300, "paste: number");
        d = Parse("{\"cmd\":\"watch\",\"vks\":[163,165,27]}") as Dictionary<string, object>;
        List<object> vks = d == null ? null : d["vks"] as List<object>;
        Check(vks != null && vks.Count == 3 && (double)vks[2] == 27, "watch: array");
        d = Parse("{\"cmd\":\"clipboard\",\"text\":\"\",\"noHistory\":true}") as Dictionary<string, object>;
        Check(d != null && d["noHistory"] is bool && (bool)d["noHistory"], "clipboard: bool");
        d = Parse("{\"cmd\":\"type\",\"text\":\"\\ud83d\\ude00\"}") as Dictionary<string, object>;
        Check(d != null && (string)d["text"] == "\U0001F600", "surrogate pair escape");

        // 1b. restoreMs clamp (paste / placeAt): a bad value must not stall injection.
        MethodInfo clamp = helper.GetMethod("ClampMs", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);
        Check(clamp != null, "ClampMs exists");
        if (clamp != null)
        {
            Check((int)clamp.Invoke(null, new object[] { 1e9 }) == 60000, "ClampMs: huge -> 60000");
            Check((int)clamp.Invoke(null, new object[] { -5.0 }) == 0, "ClampMs: negative -> 0");
            Check((int)clamp.Invoke(null, new object[] { double.NaN }) == 300, "ClampMs: NaN -> default 300");
            Check((int)clamp.Invoke(null, new object[] { double.PositiveInfinity }) == 300, "ClampMs: infinity -> default 300");
            Check((int)clamp.Invoke(null, new object[] { 450.7 }) == 450, "ClampMs: normal value kept");
        }

        // 2. Hostile shapes: deep nesting must not overflow the stack.
        foreach (int depth in new int[] { 100, 1000, 100000 })
        {
            ParseSafely(new string('[', depth), "deep array nesting " + depth);
            StringBuilder sb = new StringBuilder();
            for (int k = 0; k < depth; k++) sb.Append("{\"a\":");
            ParseSafely(sb.ToString(), "deep object nesting " + depth);
        }

        // 3. Truncated / malformed inputs.
        string[] odd = {
            "", "{", "[", "\"", "{\"", "{\"cmd\"", "{\"cmd\":", "{\"cmd\":\"pa", "{\"text\":\"\\", "{\"text\":\"\\u12",
            "{\"text\":\"\\uZZZZ\"}", "nul", "tru", "fals", "-", "1e999999", "--1", "{\"a\":1,,}", "[1,,2]", "}}}}", "]]]]",
            "{\"cmd\" \"x\"}", "{1:2}", "\u0000\u0001", "{\"cmd\":\"paste\",\"restoreMs\":1e308}",
        };
        for (int k = 0; k < odd.Length; k++) ParseSafely(odd[k], "malformed #" + k);

        // 4. Random fuzz (deterministic seed): random bytes and mutated messages.
        Random rnd = new Random(12345);
        string alphabet = "{}[]\":,\\u0123456789abcdeftrunlx -+.eE\t\n";
        string seed = "{\"cmd\":\"placeAt\",\"text\":\"hi\",\"x\":10,\"y\":20,\"restoreMs\":300}";
        for (int n = 0; n < 20000; n++)
        {
            StringBuilder sb = new StringBuilder();
            if (n % 2 == 0)
            {
                int len = rnd.Next(0, 80);
                for (int k = 0; k < len; k++) sb.Append(alphabet[rnd.Next(alphabet.Length)]);
            }
            else
            {
                sb.Append(seed);
                int edits = rnd.Next(1, 6);
                for (int k = 0; k < edits; k++)
                {
                    int pos = rnd.Next(sb.Length + 1);
                    int op = rnd.Next(3);
                    if (op == 0 && pos < sb.Length) sb.Remove(pos, 1);
                    else if (op == 1) sb.Insert(pos, alphabet[rnd.Next(alphabet.Length)]);
                    else if (pos < sb.Length) sb[pos] = alphabet[rnd.Next(alphabet.Length)];
                }
            }
            try { Parse(sb.ToString()); _passed++; }
            catch (TargetInvocationException ex)
            {
                _failed++;
                Console.WriteLine("FAIL: fuzz input " + n + " threw " + ex.InnerException.GetType().Name + ": " + sb.ToString());
                if (_failed > 20) break;
            }
        }

        Console.WriteLine("helper-json-fuzz: " + _passed + " passed, " + _failed + " failed");
        return _failed == 0 ? 0 : 1;
    }
}
