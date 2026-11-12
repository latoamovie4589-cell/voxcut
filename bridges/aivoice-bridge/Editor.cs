// A.I.VOICE Editor API の呼び出し部分。
//
// AI.Talk.Editor.Api.dll はコンパイル時に参照せず、実行時にインストール先から読み込んで
// リフレクションで呼ぶ。こうすると A.I.VOICE が入っていない PC（CI など）でもビルドでき、
// DLL を再配布せずに済む。
//
// 使っている API（公式マニュアル「A.I.VOICE Editor API」より）：
//   TtsControl.GetAvailableHostNames / Initialize / StartHost / Connect / Disconnect / Status / Version
//   CurrentVoicePresetName / Text / MasterControl（JSON 文字列）/ SaveAudioToFile
// VoicePresetNames（プリセット名一覧）は実機で名前を確認すること。

using System;
using System.IO;
using System.Reflection;
using System.Collections.Generic;

namespace VoxCut.AivoiceBridge;

internal static class Editor
{
    private const string ApiDll = "AI.Talk.Editor.Api.dll";
    private const string TtsControlType = "AI.Talk.Editor.Api.TtsControl";

    private static object? _tts;
    private static Type? _type;

    /// <summary>A.I.VOICE のインストール先候補（環境変数 AIVOICE_DIR が最優先）</summary>
    public static IEnumerable<string> InstallDirs()
    {
        var env = Environment.GetEnvironmentVariable("AIVOICE_DIR");
        if (!string.IsNullOrEmpty(env)) yield return env!;
        var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        yield return Path.Combine(pf, "AI", "AIVoice", "AIVoiceEditor");
        yield return Path.Combine(pf, "AI", "AIVoice2", "AIVoice2Editor");
    }

    private static Type LoadType()
    {
        if (_type != null) return _type;
        foreach (var dir in InstallDirs())
        {
            var path = Path.Combine(dir, ApiDll);
            if (!File.Exists(path)) continue;
            var asm = Assembly.LoadFrom(path);
            _type = asm.GetType(TtsControlType, throwOnError: true)!;
            return _type;
        }
        throw new BridgeException("HostNotFound");
    }

    private static object? Get(string name) => _type!.GetProperty(name)!.GetValue(_tts);
    private static void Set(string name, object? value) => _type!.GetProperty(name)!.SetValue(_tts, value);
    private static object? Call(string name, params object?[] args)
    {
        try
        {
            return _type!.GetMethod(name, Array.ConvertAll(args, a => a?.GetType() ?? typeof(object)))!.Invoke(_tts, args);
        }
        catch (TargetInvocationException e) when (e.InnerException != null)
        {
            throw e.InnerException;
        }
    }

    /// <summary>HostStatus は enum なので名前で比べる（NotRunning / NotConnected / Idle / Busy）</summary>
    private static string Status() => Get("Status")?.ToString() ?? "Unknown";

    private static void Connected()
    {
        if (_tts == null)
        {
            var type = LoadType();
            var tts = Activator.CreateInstance(type)!;
            _tts = tts;
            var hosts = (string[]?)Call("GetAvailableHostNames");
            if (hosts == null || hosts.Length == 0)
            {
                _tts = null;
                throw new BridgeException("HostNotFound");
            }
            Call("Initialize", hosts[0]);
        }
        if (Status() == "NotRunning") Call("StartHost");
        if (Status() == "NotConnected") Call("Connect");
    }

    public static object StatusInfo()
    {
        Connected();
        return new Dictionary<string, object?> { ["status"] = Status(), ["version"] = Get("Version")?.ToString() };
    }

    public static string[] ListVoices()
    {
        Connected();
        return (string[]?)Get("VoicePresetNames") ?? Array.Empty<string>();
    }

    public static object Synthesize(string preset, string text, Dictionary<string, object?>? param, string outPath)
    {
        Connected();
        WaitIdle();
        Set("CurrentVoicePresetName", preset);

        if (param != null)
        {
            // 既存の MasterControl に、渡された数値だけを上書きする
            var mc = MiniJson.Parse((string)Get("MasterControl")!) as Dictionary<string, object?> ?? new Dictionary<string, object?>();
            foreach (var kv in param)
            {
                if (kv.Value is double d) mc[kv.Key] = d;
            }
            Set("MasterControl", MiniJson.Serialize(mc));
        }

        Set("Text", text);
        Call("SaveAudioToFile", outPath); // 同期。終わるまで戻らない
        return new Dictionary<string, object?> { ["out"] = outPath };
    }

    private static void WaitIdle()
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (Status() == "Busy")
        {
            if (DateTime.UtcNow > deadline) throw new BridgeException("Busy");
            System.Threading.Thread.Sleep(50);
        }
    }

    public static void Disconnect()
    {
        try
        {
            if (_tts != null && Status() is not ("NotConnected" or "NotRunning")) Call("Disconnect");
        }
        catch
        {
            // 終了時なので無視
        }
    }
}
