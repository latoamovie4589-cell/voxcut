// 依存ゼロの小さな JSON 読み書き。
// net48 で System.Text.Json を使うと DLL が 8 個ほど増え、Tauri のサイドカー（単一 exe）として配れないため自前で持つ。
// やり取りする JSON は小さく単純（オブジェクト・配列・文字列・数値・真偽・null）なので、これで足りる。
//
// 値の対応：object → Dictionary<string, object?>、array → List<object?>、number → double、string、bool、null

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace VoxCut.AivoiceBridge;

internal static class MiniJson
{
    public static object? Parse(string s)
    {
        var i = 0;
        var v = Value(s, ref i);
        Ws(s, ref i);
        if (i != s.Length) throw new FormatException($"JSON の後ろに余計な文字があります（{i} 文字目）");
        return v;
    }

    private static void Ws(string s, ref int i)
    {
        while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
    }

    private static object? Value(string s, ref int i)
    {
        Ws(s, ref i);
        if (i >= s.Length) throw new FormatException("JSON が途中で終わっています");
        switch (s[i])
        {
            case '{':
                {
                    i++;
                    var d = new Dictionary<string, object?>();
                    Ws(s, ref i);
                    if (s[i] == '}') { i++; return d; }
                    while (true)
                    {
                        Ws(s, ref i);
                        var k = Str(s, ref i);
                        Ws(s, ref i);
                        Expect(s, ref i, ':');
                        d[k] = Value(s, ref i);
                        Ws(s, ref i);
                        if (s[i] == ',') { i++; continue; }
                        Expect(s, ref i, '}');
                        return d;
                    }
                }
            case '[':
                {
                    i++;
                    var l = new List<object?>();
                    Ws(s, ref i);
                    if (s[i] == ']') { i++; return l; }
                    while (true)
                    {
                        l.Add(Value(s, ref i));
                        Ws(s, ref i);
                        if (s[i] == ',') { i++; continue; }
                        Expect(s, ref i, ']');
                        return l;
                    }
                }
            case '"':
                return Str(s, ref i);
            case 't':
                Lit(s, ref i, "true");
                return true;
            case 'f':
                Lit(s, ref i, "false");
                return false;
            case 'n':
                Lit(s, ref i, "null");
                return null;
            default:
                {
                    var start = i;
                    while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
                    if (start == i) throw new FormatException($"JSON として読めません（{i} 文字目）");
                    return double.Parse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture);
                }
        }
    }

    private static void Expect(string s, ref int i, char c)
    {
        if (i >= s.Length || s[i] != c) throw new FormatException($"'{c}' がありません（{i} 文字目）");
        i++;
    }

    private static void Lit(string s, ref int i, string lit)
    {
        if (string.CompareOrdinal(s, i, lit, 0, lit.Length) != 0) throw new FormatException($"JSON として読めません（{i} 文字目）");
        i += lit.Length;
    }

    private static string Str(string s, ref int i)
    {
        Expect(s, ref i, '"');
        var sb = new StringBuilder();
        while (true)
        {
            if (i >= s.Length) throw new FormatException("文字列が閉じていません");
            var c = s[i++];
            if (c == '"') return sb.ToString();
            if (c != '\\') { sb.Append(c); continue; }
            var e = s[i++];
            switch (e)
            {
                case '"': sb.Append('"'); break;
                case '\\': sb.Append('\\'); break;
                case '/': sb.Append('/'); break;
                case 'b': sb.Append('\b'); break;
                case 'f': sb.Append('\f'); break;
                case 'n': sb.Append('\n'); break;
                case 'r': sb.Append('\r'); break;
                case 't': sb.Append('\t'); break;
                case 'u':
                    sb.Append((char)Convert.ToInt32(s.Substring(i, 4), 16));
                    i += 4;
                    break;
                default: throw new FormatException($"不明なエスケープ \\{e}");
            }
        }
    }

    public static string Serialize(object? v)
    {
        var sb = new StringBuilder();
        Write(sb, v);
        return sb.ToString();
    }

    private static void Write(StringBuilder sb, object? v)
    {
        switch (v)
        {
            case null: sb.Append("null"); break;
            case bool b: sb.Append(b ? "true" : "false"); break;
            case string s: WriteStr(sb, s); break;
            case double d: sb.Append(d.ToString("R", CultureInfo.InvariantCulture)); break;
            case float f: sb.Append(((double)f).ToString("R", CultureInfo.InvariantCulture)); break;
            case int or long or short or byte or uint or ulong: sb.Append(Convert.ToString(v, CultureInfo.InvariantCulture)); break;
            case IDictionary dict:
                {
                    sb.Append('{');
                    var first = true;
                    foreach (DictionaryEntry kv in dict)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        WriteStr(sb, kv.Key.ToString()!);
                        sb.Append(':');
                        Write(sb, kv.Value);
                    }
                    sb.Append('}');
                    break;
                }
            case IEnumerable list:
                {
                    sb.Append('[');
                    var first = true;
                    foreach (var x in list)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        Write(sb, x);
                    }
                    sb.Append(']');
                    break;
                }
            default: WriteStr(sb, v.ToString() ?? ""); break;
        }
    }

    private static void WriteStr(StringBuilder sb, string s)
    {
        sb.Append('"');
        foreach (var c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c); // 日本語はそのまま（UTF-8 で出す）
                    break;
            }
        }
        sb.Append('"');
    }
}
