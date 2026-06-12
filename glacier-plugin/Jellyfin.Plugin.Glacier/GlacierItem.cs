namespace Jellyfin.Plugin.Glacier;

public enum GlacierStatus
{
    OnGlacier,
    RestoreRequested,
    Restoring,
    Ready,
    Downloading,
    Available
}

public class GlacierItem
{
    public Guid JellyfinItemId { get; set; }
    public string Title { get; set; } = string.Empty;
    public string LocalPath { get; set; } = string.Empty;      // chemin local (placeholder ou vrai fichier)
    public string ObjectKey { get; set; } = string.Empty;      // clé dans le bucket Scaleway
    public long FileSizeBytes { get; set; }
    public GlacierStatus Status { get; set; } = GlacierStatus.OnGlacier;
    public DateTime? RestoreRequestedAt { get; set; }
    public DateTime? AvailableAt { get; set; }
    public int RestoreExpiryDays { get; set; } = 7;
}
