using System.Reflection;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Glacier;

public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public static Plugin? Instance { get; private set; }

    public GlacierDb Db { get; }
    public GlacierService Service { get; }

    public Plugin(
        IApplicationPaths appPaths,
        IXmlSerializer xmlSerializer,
        ILibraryManager libraryManager,
        ILogger<GlacierService> serviceLogger)
        : base(appPaths, xmlSerializer)
    {
        Instance = this;
        Db = new GlacierDb(appPaths.DataPath);
        Service = new GlacierService(Db, libraryManager, serviceLogger);
    }

    public override string Name => "Glacier";
    public override Guid Id => Guid.Parse("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    public override string Description => "Archivage et récupération de films depuis Scaleway Glacier";

    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = "GlacierConfigPage",
            EmbeddedResourcePath = $"{GetType().Namespace}.Configuration.configPage.html"
        };
    }
}
