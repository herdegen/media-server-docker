using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.Glacier;

public class PluginConfiguration : BasePluginConfiguration
{
    public string ScalewayAccessKey { get; set; } = string.Empty;
    public string ScalewaySecretKey { get; set; } = string.Empty;
    public string BucketName { get; set; } = string.Empty;
    public string Region { get; set; } = "fr-par";
    public int PollIntervalMinutes { get; set; } = 5;
    public string NotificationUrl { get; set; } = string.Empty; // ntfy ou webhook
}
