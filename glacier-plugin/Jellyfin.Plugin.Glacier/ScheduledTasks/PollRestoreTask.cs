using MediaBrowser.Model.Tasks;
using static MediaBrowser.Model.Tasks.TaskTriggerInfo;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Glacier.ScheduledTasks;

public class PollRestoreTask : IScheduledTask
{
    private readonly ILogger<PollRestoreTask> _logger;

    public PollRestoreTask(ILogger<PollRestoreTask> logger)
    {
        _logger = logger;
    }

    public string Name => "Glacier - Vérifier les restaurations en cours";
    public string Key => "GlacierPollRestore";
    public string Description => "Vérifie si des films en cours de restauration depuis Scaleway Glacier sont prêts à être téléchargés.";
    public string Category => "Glacier";

    public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        if (Plugin.Instance == null) return;

        _logger.LogInformation("[Glacier] Lancement du poll de restauration");
        progress.Report(0);

        await Plugin.Instance.Service.PollAndDownloadAsync();

        progress.Report(100);
        _logger.LogInformation("[Glacier] Poll terminé");
    }

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        yield return new TaskTriggerInfo
        {
            Type = TaskTriggerInfoType.IntervalTrigger,
            IntervalTicks = TimeSpan.FromMinutes(
                Plugin.Instance?.Configuration.PollIntervalMinutes ?? 5
            ).Ticks
        };
    }
}
