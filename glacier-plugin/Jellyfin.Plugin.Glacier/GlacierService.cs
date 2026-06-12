using Amazon;
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using Amazon.S3.Transfer;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Glacier;

public class GlacierService
{
    private readonly GlacierDb _db;
    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<GlacierService> _logger;

    public GlacierService(GlacierDb db, ILibraryManager libraryManager, ILogger<GlacierService> logger)
    {
        _db = db;
        _libraryManager = libraryManager;
        _logger = logger;
    }

    private AmazonS3Client CreateClient()
    {
        var config = Plugin.Instance!.Configuration;
        var credentials = new BasicAWSCredentials(config.ScalewayAccessKey, config.ScalewaySecretKey);
        var s3Config = new AmazonS3Config
        {
            ServiceURL = $"https://s3.{config.Region}.scw.cloud",
            ForcePathStyle = true,
            SignatureVersion = "4",
            AuthenticationRegion = config.Region,
            Timeout = TimeSpan.FromHours(2),
            ReadWriteTimeout = TimeSpan.FromHours(2)
        };
        return new AmazonS3Client(credentials, s3Config);
    }

    // Estime le délai de restore en minutes selon la taille du fichier
    public int EstimateRestoreMinutes(long fileSizeBytes)
    {
        // Scaleway Glacier restore : ~1-5 min + téléchargement estimé à ~100 Mbps
        const int restoreMinutes = 3;
        double downloadMinutes = (fileSizeBytes / (100.0 * 1024 * 1024 / 8)) / 60.0;
        return restoreMinutes + (int)Math.Ceiling(downloadMinutes);
    }

    public async Task<List<GlacierItem>> GetAllItemsAsync()
        => await _db.GetAllAsync();

    public async Task<GlacierItem?> GetItemAsync(Guid itemId)
        => await _db.GetByItemIdAsync(itemId);

    // Envoie un film vers Glacier et crée un placeholder local
    public async Task SendToGlacierAsync(Guid itemId, string objectKey)
    {
        var jellyfinItem = _libraryManager.GetItemById(itemId);
        if (jellyfinItem == null) throw new Exception($"Item {itemId} introuvable dans Jellyfin");

        var localPath = jellyfinItem.Path;
        if (!File.Exists(localPath)) throw new Exception($"Fichier introuvable : {localPath}");

        var fileSize = new FileInfo(localPath).Length;

        using var client = CreateClient();
        var config = Plugin.Instance!.Configuration;

        _logger.LogInformation("[Glacier] Upload de {Path} → s3://{Bucket}/{Key}", localPath, config.BucketName, objectKey);

        // Utilise awscli pour l'upload (contourne les limitations de timeout du SDK .NET)
        var endpoint = $"https://s3.{config.Region}.scw.cloud";
        var args = $"s3 cp \"{localPath}\" s3://{config.BucketName}/{objectKey} --storage-class GLACIER --endpoint-url {endpoint} --region {config.Region}";

        var psi = new System.Diagnostics.ProcessStartInfo("aws", args)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            Environment =
            {
                ["AWS_ACCESS_KEY_ID"] = config.ScalewayAccessKey,
                ["AWS_SECRET_ACCESS_KEY"] = config.ScalewaySecretKey
            }
        };

        using var process = System.Diagnostics.Process.Start(psi)!;
        var stderr = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync(CancellationToken.None);

        if (process.ExitCode != 0)
            throw new Exception($"aws s3 cp échoué (code {process.ExitCode}) : {stderr}");

        // Remplace le fichier vidéo par un stub vide avec le même nom .mkv
        // Jellyfin garde l'entrée en lib tant que le fichier existe
        File.Delete(localPath);
        await File.WriteAllTextAsync(localPath, $"GLACIER_STUB:{objectKey}");

        var item = new GlacierItem
        {
            JellyfinItemId = itemId,
            Title = jellyfinItem.Name,
            LocalPath = localPath,
            ObjectKey = objectKey,
            FileSizeBytes = fileSize,
            Status = GlacierStatus.OnGlacier
        };

        await _db.UpsertAsync(item);
        _logger.LogInformation("[Glacier] {Title} archivé avec succès", item.Title);
    }

    // Demande la restauration depuis Glacier
    public async Task RequestRestoreAsync(Guid itemId)
    {
        var item = await _db.GetByItemIdAsync(itemId);
        if (item == null) throw new Exception($"Item {itemId} non trouvé dans Glacier");
        if (item.Status != GlacierStatus.OnGlacier)
            throw new Exception($"Item déjà en cours de restauration ou disponible (status: {item.Status})");

        using var client = CreateClient();
        var config = Plugin.Instance!.Configuration;

        var restoreRequest = new RestoreObjectRequest
        {
            BucketName = config.BucketName,
            Key = item.ObjectKey,
            Days = item.RestoreExpiryDays
        };

        await client.RestoreObjectAsync(restoreRequest);

        item.Status = GlacierStatus.RestoreRequested;
        item.RestoreRequestedAt = DateTime.UtcNow;
        await _db.UpsertAsync(item);

        _logger.LogInformation("[Glacier] Restore demandé pour {Title}", item.Title);
    }

    // Vérifie si la restauration est terminée et télécharge si prêt
    public async Task PollAndDownloadAsync()
    {
        var items = await _db.GetAllAsync();
        var pending = items.Where(i => i.Status is GlacierStatus.RestoreRequested or GlacierStatus.Restoring).ToList();

        if (!pending.Any()) return;

        using var client = CreateClient();
        var config = Plugin.Instance!.Configuration;

        foreach (var item in pending)
        {
            try
            {
                var meta = await client.GetObjectMetadataAsync(config.BucketName, item.ObjectKey);
                var restoreStatus = meta.RestoreInProgress;

                if (restoreStatus == true)
                {
                    item.Status = GlacierStatus.Restoring;
                    await _db.UpsertAsync(item);
                    _logger.LogInformation("[Glacier] {Title} : restore en cours...", item.Title);
                }
                else
                {
                    // Restore terminé → téléchargement
                    _logger.LogInformation("[Glacier] {Title} prêt, téléchargement...", item.Title);
                    item.Status = GlacierStatus.Downloading;
                    await _db.UpsertAsync(item);

                    await DownloadAsync(client, item, config.BucketName);

                    item.Status = GlacierStatus.Available;
                    item.AvailableAt = DateTime.UtcNow;
                    await _db.UpsertAsync(item);

                    // Supprimer le placeholder
                    var placeholder = item.LocalPath + ".glacier";
                    if (File.Exists(placeholder)) File.Delete(placeholder);

                    // Déclencher un scan Jellyfin
                    _libraryManager.QueueLibraryScan();

                    await SendNotificationAsync(item);

                    _logger.LogInformation("[Glacier] {Title} disponible dans Jellyfin", item.Title);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[Glacier] Erreur lors du poll pour {Title}", item.Title);
            }
        }
    }

    private async Task DownloadAsync(AmazonS3Client client, GlacierItem item, string bucket)
    {
        var response = await client.GetObjectAsync(bucket, item.ObjectKey);
        var dir = Path.GetDirectoryName(item.LocalPath)!;
        Directory.CreateDirectory(dir);

        using var fileStream = File.Create(item.LocalPath);
        await response.ResponseStream.CopyToAsync(fileStream);
    }

    private async Task SendNotificationAsync(GlacierItem item)
    {
        var url = Plugin.Instance!.Configuration.NotificationUrl;
        if (string.IsNullOrWhiteSpace(url)) return;

        try
        {
            using var http = new HttpClient();
            await http.PostAsync(url, new StringContent($"🎬 \"{item.Title}\" est prêt dans Jellyfin !"));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Glacier] Notification échouée");
        }
    }
}
