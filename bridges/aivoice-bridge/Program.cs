// VoxCut ⇔ A.I.VOICE Editor の中継プロセス。
// 標準入力から1行1件の JSON を受け取り、1行1件の JSON を返す（JSON Lines）。
//
//   → {"id":1,"cmd":"status"}
//   ← {"id":1,"ok":true,"result":{"status":"Idle","version":"1.4.x"}}
//   → {"id":2,"cmd":"listVoices"}
//   → {"id":3,"cmd":"synthesize","preset":"琴葉 茜","text":"…","params":{"Speed":1.0,"Pitch":1.0,"PitchRange":1.0},"out":"C:\\…\\x.wav"}
//   → {"id":0,"cmd":"quit"}

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;

namespace VoxCut.AivoiceBridge;

internal static class Program
{
    private static int Main()
    {
        // API の DLL とその依存を A.I.VOICE のインストール先から読む（同梱しない）
        AppDomain.CurrentDomain.AssemblyResolve += ResolveFromInstallDir;

        var utf8 = new UTF8Encoding(false);
        Console.InputEncoding = utf8;
        Console.OutputEncoding = utf8;
        using var stdin = new StreamReader(Console.OpenStandardInput(), utf8);
        using var stdout = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true };

        string? line;
        while ((line = stdin.ReadLine()) != null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            object? id = 0.0;
            try
            {
                var m = MiniJson.Parse(line) as Dictionary<string, object?> ?? throw new BridgeException("BadRequest");
                id = m.TryGetValue("id", out var idv) ? idv : 0.0;
                string Str(string k) => m.TryGetValue(k, out var v) && v is string s ? s : throw new BridgeException($"Missing:{k}");
                var cmd = Str("cmd");
                if (cmd == "quit") break;
                object? result = cmd switch
                {
                    "status" => Editor.StatusInfo(),
                    "listVoices" => Editor.ListVoices(),
                    "synthesize" => Editor.Synthesize(
                        Str("preset"),
                        Str("text"),
                        m.TryGetValue("params", out var p) ? p as Dictionary<string, object?> : null,
                        Str("out")),
                    _ => throw new BridgeException("UnknownCommand"),
                };
                Write(stdout, new Dictionary<string, object?> { ["id"] = id, ["ok"] = true, ["result"] = result });
            }
            catch (Exception e)
            {
                var msg = e is BridgeException b ? b.Code : (e.InnerException ?? e).Message;
                Write(stdout, new Dictionary<string, object?> { ["id"] = id, ["ok"] = false, ["error"] = msg });
            }
        }
        Editor.Disconnect();
        return 0;
    }

    private static void Write(StreamWriter w, object value) => w.WriteLine(MiniJson.Serialize(value));

    /// <summary>API の DLL が依存するアセンブリも、A.I.VOICE のインストール先から探す</summary>
    private static Assembly? ResolveFromInstallDir(object? sender, ResolveEventArgs args)
    {
        var name = new AssemblyName(args.Name).Name + ".dll";
        foreach (var d in Editor.InstallDirs())
        {
            var path = Path.Combine(d, name);
            if (File.Exists(path)) return Assembly.LoadFrom(path);
        }
        return null;
    }
}

internal sealed class BridgeException(string code) : Exception(code)
{
    public string Code { get; } = code;
}
