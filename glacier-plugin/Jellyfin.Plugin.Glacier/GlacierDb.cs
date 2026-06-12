using System.Text.Json;

namespace Jellyfin.Plugin.Glacier;

public class GlacierDb
{
    private readonly string _dbPath;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private List<GlacierItem> _items = new();

    public GlacierDb(string dataDir)
    {
        _dbPath = Path.Combine(dataDir, "glacier_items.json");
        Load();
    }

    private void Load()
    {
        if (!File.Exists(_dbPath)) return;
        try
        {
            var json = File.ReadAllText(_dbPath);
            _items = JsonSerializer.Deserialize<List<GlacierItem>>(json) ?? new();
        }
        catch { _items = new(); }
    }

    private void Save()
    {
        var dir = Path.GetDirectoryName(_dbPath)!;
        Directory.CreateDirectory(dir);
        File.WriteAllText(_dbPath, JsonSerializer.Serialize(_items, new JsonSerializerOptions { WriteIndented = true }));
    }

    public async Task<List<GlacierItem>> GetAllAsync()
    {
        await _lock.WaitAsync();
        try { return _items.ToList(); }
        finally { _lock.Release(); }
    }

    public async Task<GlacierItem?> GetByItemIdAsync(Guid itemId)
    {
        await _lock.WaitAsync();
        try { return _items.FirstOrDefault(x => x.JellyfinItemId == itemId); }
        finally { _lock.Release(); }
    }

    public async Task UpsertAsync(GlacierItem item)
    {
        await _lock.WaitAsync();
        try
        {
            var idx = _items.FindIndex(x => x.JellyfinItemId == item.JellyfinItemId);
            if (idx >= 0) _items[idx] = item;
            else _items.Add(item);
            Save();
        }
        finally { _lock.Release(); }
    }

    public async Task RemoveAsync(Guid itemId)
    {
        await _lock.WaitAsync();
        try
        {
            _items.RemoveAll(x => x.JellyfinItemId == itemId);
            Save();
        }
        finally { _lock.Release(); }
    }
}
