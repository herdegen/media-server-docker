using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Glacier.Api;

[ApiController]
[Route("Glacier")]
public class GlacierController : ControllerBase
{
    private readonly ILogger<GlacierController> _logger;

    public GlacierController(ILogger<GlacierController> logger)
    {
        _logger = logger;
    }

    private GlacierService Service => Plugin.Instance!.Service;

    /// <summary>
    /// Liste tous les films en Glacier.
    /// </summary>
    [HttpGet("items")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<IEnumerable<GlacierItemDto>>> GetItems()
    {
        var items = await Service.GetAllItemsAsync();
        return Ok(items.Select(ToDto));
    }

    /// <summary>
    /// Récupère le statut d'un film.
    /// </summary>
    [HttpGet("items/{itemId}")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<GlacierItemDto>> GetItem([FromRoute] Guid itemId)
    {
        var item = await Service.GetItemAsync(itemId);
        if (item == null) return NotFound();
        return Ok(ToDto(item));
    }

    /// <summary>
    /// Archive un film vers Glacier (upload + suppression locale).
    /// </summary>
    [HttpPost("items/{itemId}/archive")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public ActionResult ArchiveItem([FromRoute] Guid itemId)
    {
        var objectKey = $"movies/{itemId}.mkv";

        // Lance l'upload en tâche de fond et répond immédiatement
        _ = Task.Run(async () =>
        {
            try
            {
                await Service.SendToGlacierAsync(itemId, objectKey);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[Glacier] Erreur archive pour {ItemId}", itemId);
            }
        });

        return Accepted(new { message = "Upload Glacier démarré en arrière-plan" });
    }

    /// <summary>
    /// Demande la restauration d'un film depuis Glacier.
    /// </summary>
    [HttpPost("items/{itemId}/restore")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<RestoreResponseDto>> RequestRestore([FromRoute] Guid itemId)
    {
        try
        {
            var item = await Service.GetItemAsync(itemId);
            if (item == null) return NotFound();

            await Service.RequestRestoreAsync(itemId);

            var estimatedMinutes = Service.EstimateRestoreMinutes(item.FileSizeBytes);
            return Ok(new RestoreResponseDto
            {
                Message = "Restauration lancée",
                EstimatedMinutes = estimatedMinutes
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Glacier] Erreur restore pour {ItemId}", itemId);
            return BadRequest(new { error = ex.Message });
        }
    }

    private static GlacierItemDto ToDto(GlacierItem item) => new()
    {
        JellyfinItemId = item.JellyfinItemId,
        Title = item.Title,
        Status = item.Status.ToString(),
        FileSizeBytes = item.FileSizeBytes,
        RestoreRequestedAt = item.RestoreRequestedAt,
        AvailableAt = item.AvailableAt
    };
}

public class GlacierItemDto
{
    public Guid JellyfinItemId { get; set; }
    public string Title { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public long FileSizeBytes { get; set; }
    public DateTime? RestoreRequestedAt { get; set; }
    public DateTime? AvailableAt { get; set; }
}

public class RestoreResponseDto
{
    public string Message { get; set; } = string.Empty;
    public int EstimatedMinutes { get; set; }
}
