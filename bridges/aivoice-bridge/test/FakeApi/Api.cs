// テスト用の偽 A.I.VOICE API（実物と同じ名前の型・メンバーだけを持つ）
using System; using System.IO;
namespace AI.Talk.Editor.Api {
  public enum HostStatus { NotRunning, NotConnected, Idle, Busy }
  public class TtsControl {
    public HostStatus Status { get; private set; } = HostStatus.NotRunning;
    public string Version => "9.9.9-fake";
    public string[] VoicePresetNames => new[] { "琴葉 茜", "琴葉 葵" };
    public string CurrentVoicePresetName { get; set; }
    public string Text { get; set; }
    public string MasterControl { get; set; } = "{\"Volume\":1.0,\"Speed\":1.0,\"Pitch\":1.0,\"PitchRange\":1.0,\"MiddlePause\":150,\"LongPause\":370,\"SentencePause\":800}";
    public string[] GetAvailableHostNames() => new[] { "A.I.VOICE Editor" };
    public void Initialize(string host) { Status = HostStatus.NotRunning; }
    public void StartHost() { Status = HostStatus.NotConnected; }
    public void Connect() { Status = HostStatus.Idle; }
    public void Disconnect() { Status = HostStatus.NotConnected; }
    public void SaveAudioToFile(string path) {
      // 中身を確かめられるよう、設定値を書き出す（WAV ではない）
      File.WriteAllText(path, $"{CurrentVoicePresetName}|{Text}|{MasterControl}");
    }
  }
}
