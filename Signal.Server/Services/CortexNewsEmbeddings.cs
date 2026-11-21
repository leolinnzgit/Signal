using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;
using Microsoft.ML.Tokenizers;

namespace Signal.Server.Services;

internal interface ICortexNewsEmbeddings
{
    ValueTask<float[]> EmbedAsync(string text, CancellationToken cancellationToken);
}

internal sealed class CortexNewsEmbeddings : ICortexNewsEmbeddings, IDisposable
{
    internal const int Dimensions = 384;
    private const int MaxTokens = 256;
    private readonly SemaphoreSlim _inference = new(1);
    private readonly Lazy<(BertTokenizer Tokenizer, InferenceSession Session)> _model;

    public CortexNewsEmbeddings(IWebHostEnvironment environment)
    {
        _model = new(() =>
        {
            var modelDirectory = Path.Combine(environment.ContentRootPath, "App_Data", "cortex-news-model");
            var tokenizer = BertTokenizer.Create(Path.Combine(modelDirectory, "vocab.txt"),
                new BertOptions { LowerCaseBeforeTokenization = true });
            using var options = new Microsoft.ML.OnnxRuntime.SessionOptions { IntraOpNumThreads = 1, InterOpNumThreads = 1 };
            return (tokenizer, new InferenceSession(Path.Combine(modelDirectory, "model.onnx"), options));
        });
    }

    public async ValueTask<float[]> EmbedAsync(string text, CancellationToken cancellationToken)
    {
        await _inference.WaitAsync(cancellationToken);
        try
        {
            return Embed(text, cancellationToken);
        }
        catch (OnnxRuntimeException) when (cancellationToken.IsCancellationRequested)
        {
            throw new OperationCanceledException(cancellationToken);
        }
        finally
        {
            _inference.Release();
        }
    }

    private float[] Embed(string text, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var (tokenizer, session) = _model.Value;
        var tokens = tokenizer.EncodeToIds(text, MaxTokens, true, out _, out _);
        int[] shape = [1, tokens.Count];
        var ids = new DenseTensor<long>(tokens.Select(token => (long)token).ToArray(), shape);
        var mask = new DenseTensor<long>(Enumerable.Repeat(1L, tokens.Count).ToArray(), shape);
        var segments = new DenseTensor<long>(shape);
        using var runOptions = new RunOptions();
        using var registration = cancellationToken.Register(() => runOptions.Terminate = true);
        using var output = session.Run(
            [
                NamedOnnxValue.CreateFromTensor("input_ids", ids),
                NamedOnnxValue.CreateFromTensor("attention_mask", mask),
                NamedOnnxValue.CreateFromTensor("token_type_ids", segments),
            ],
            ["last_hidden_state"],
            runOptions);
        var hidden = output.Single().AsTensor<float>();
        if (hidden.Rank != 3 || hidden.Dimensions[1] != tokens.Count || hidden.Dimensions[2] != Dimensions)
            throw new InvalidOperationException("The Cortex embedding model returned unexpected dimensions.");

        var vector = new float[Dimensions];
        // Every token in this unpadded input has an attention mask of one. The
        // mean and the sum normalize to the same direction.
        for (var token = 0; token < tokens.Count; token++)
        {
            for (var dimension = 0; dimension < Dimensions; dimension++)
                vector[dimension] += hidden[0, token, dimension];
        }
        var norm = MathF.Sqrt(vector.Sum(value => value * value));
        if (!float.IsFinite(norm) || norm <= 0)
            throw new InvalidOperationException("The Cortex embedding model returned an invalid vector.");
        for (var i = 0; i < vector.Length; i++)
            vector[i] /= norm;
        return vector;
    }

    public void Dispose()
    {
        if (_model.IsValueCreated) _model.Value.Session.Dispose();
        _inference.Dispose();
    }
}
