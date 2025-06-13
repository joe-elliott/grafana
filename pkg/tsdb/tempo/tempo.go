package tempo

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"runtime"
	"strings"

	"github.com/golang/protobuf/jsonpb"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/datasource"
	"github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/grafana/grafana/pkg/tsdb/tempo/kinds/dataquery"
	"github.com/grafana/grafana/pkg/tsdb/tempo/traceql"
	"github.com/grafana/tempo/pkg/tempopb"
	mcp_client "github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/mcp"
)

type Service struct {
	im     instancemgmt.InstanceManager
	logger log.Logger
}

// Return the file, line, and (full-path) function name of the caller
func getRunContext() (string, int, string) {
	pc := make([]uintptr, 10)
	runtime.Callers(2, pc)
	f := runtime.FuncForPC(pc[0])
	file, line := f.FileLine(pc[0])
	return file, line, f.Name()
}

// Return a formatted string representing the execution context for the logger
func logEntrypoint() string {
	file, line, pathToFunction := getRunContext()
	parts := strings.Split(pathToFunction, "/")
	functionName := parts[len(parts)-1]
	return fmt.Sprintf("%s:%d[%s]", file, line, functionName)
}

func ProvideService(httpClientProvider *httpclient.Provider) *Service {
	return &Service{
		logger: backend.NewLoggerWith("logger", "tsdb.tempo"),
		im:     datasource.NewInstanceManager(newInstanceSettings(httpClientProvider)),
	}
}

type Datasource struct {
	HTTPClient      *http.Client
	StreamingClient tempopb.StreamingQuerierClient
	URL             string
	MCPClient       *mcp_client.Client
}

func newInstanceSettings(httpClientProvider *httpclient.Provider) datasource.InstanceFactoryFunc {
	return func(ctx context.Context, settings backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
		ctxLogger := backend.NewLoggerWith("logger", "tsdb.tempo").FromContext(ctx)
		opts, err := settings.HTTPClientOptions(ctx)
		if err != nil {
			ctxLogger.Error("Failed to get HTTP client options", "error", err, "function", logEntrypoint())
			return nil, err
		}

		client, err := httpClientProvider.New(opts)
		if err != nil {
			ctxLogger.Error("Failed to get HTTP client provider", "error", err, "function", logEntrypoint())
			return nil, err
		}

		streamingClient, err := newGrpcClient(ctx, settings, opts)
		if err != nil {
			ctxLogger.Error("Failed to get gRPC client", "error", err, "function", logEntrypoint())
			return nil, err
		}

		// Initialize MCP client to connect to /api/mcp endpoint
		mcpClient, err := mcp_client.NewStreamableHttpClient(settings.URL + "/api/mcp")
		if err != nil {
			ctxLogger.Error("Failed to create MCP client", "error", err, "function", logEntrypoint())
			// Continue without MCP client if it fails
			mcpClient = nil
		}

		if err := mcpClient.Start(ctx); err != nil {
			return nil, fmt.Errorf("failed to start MCP client: %v", err)
		}

		// Initialize the connection with required parameters
		initReq := mcp.InitializeRequest{
			Params: mcp.InitializeParams{
				ProtocolVersion: mcp.LATEST_PROTOCOL_VERSION,
				Capabilities:    mcp.ClientCapabilities{},
				ClientInfo: mcp.Implementation{
					Name:    "grafana-datasource-tempo",
					Version: "1.0.0",
				},
			},
		}
		_, err = mcpClient.Initialize(ctx, initReq)
		if err != nil {
			return nil, fmt.Errorf("failed to initialize MCP client: %v", err)
		}

		model := &Datasource{
			HTTPClient:      client,
			StreamingClient: streamingClient,
			URL:             settings.URL,
			MCPClient:       mcpClient,
		}
		return model, nil
	}
}

func (s *Service) QueryData(ctx context.Context, req *backend.QueryDataRequest) (*backend.QueryDataResponse, error) {
	ctxLogger := s.logger.FromContext(ctx)
	ctxLogger.Debug("Processing queries", "queryLength", len(req.Queries), "function", logEntrypoint())

	// create response struct
	response := backend.NewQueryDataResponse()

	// loop over queries and execute them individually.
	for i, q := range req.Queries {
		ctxLogger.Debug("Processing query", "counter", i, "function", logEntrypoint())
		if res, err := s.query(ctx, req.PluginContext, q); err != nil {
			ctxLogger.Error("Error processing query", "error", err)
			return response, err
		} else {
			if res != nil {
				ctxLogger.Debug("Query processed", "counter", i, "function", logEntrypoint())
				response.Responses[q.RefID] = *res
			} else {
				ctxLogger.Debug("Query resulted in empty response", "counter", i, "function", logEntrypoint())
			}
		}
	}

	ctxLogger.Debug("All queries processed", "function", logEntrypoint())
	return response, nil
}

func (s *Service) query(ctx context.Context, pCtx backend.PluginContext, query backend.DataQuery) (*backend.DataResponse, error) {
	switch query.QueryType {
	case string(dataquery.TempoQueryTypeTraceId):
		return s.getTrace(ctx, pCtx, query)
	case string(dataquery.TempoQueryTypeTraceql):
		return s.runTraceQlQuery(ctx, pCtx, query)
	case "mcp":
		return s.handleMCPQuery(ctx, pCtx, query)
	}
	return nil, fmt.Errorf("unsupported query type: '%s' for query with refID '%s'", query.QueryType, query.RefID)
}

func (s *Service) getDSInfo(ctx context.Context, pluginCtx backend.PluginContext) (*Datasource, error) {
	i, err := s.im.Get(ctx, pluginCtx)
	if err != nil {
		return nil, err
	}

	instance, ok := i.(*Datasource)
	if !ok {
		return nil, fmt.Errorf("failed to cast datsource info")
	}

	return instance, nil
}

func (s *Service) ListMCPTools(ctx context.Context, pCtx backend.PluginContext) ([]mcp.Tool, error) {
	ctxLogger := s.logger.FromContext(ctx)

	ds, err := s.getDSInfo(ctx, pCtx)
	if err != nil {
		ctxLogger.Error("Failed to get datasource info", "error", err, "function", logEntrypoint())
		return nil, err
	}

	if ds.MCPClient == nil {
		return nil, fmt.Errorf("MCP client not available")
	}

	tools, err := ds.MCPClient.ListTools(ctx, mcp.ListToolsRequest{})
	if err != nil {
		ctxLogger.Error("Failed to list MCP tools", "error", err, "function", logEntrypoint())
		return nil, fmt.Errorf("failed to list MCP tools: %w", err)
	}

	return tools.Tools, nil
}

func (s *Service) handleMCPQuery(ctx context.Context, pCtx backend.PluginContext, query backend.DataQuery) (*backend.DataResponse, error) {
	ctxLogger := s.logger.FromContext(ctx)

	ds, err := s.getDSInfo(ctx, pCtx)
	if err != nil {
		ctxLogger.Error("Failed to get datasource info", "error", err, "function", logEntrypoint())
		return nil, err
	}

	if ds.MCPClient == nil {
		return nil, fmt.Errorf("MCP client not available")
	}

	// Parse the query JSON to extract MCP tool and parameters
	var mcpQuery struct {
		MCPTool       string                 `json:"mcpTool"`
		MCPParameters map[string]interface{} `json:"mcpParameters"`
	}

	if err := json.Unmarshal(query.JSON, &mcpQuery); err != nil {
		ctxLogger.Error("Failed to unmarshal MCP query", "error", err, "function", logEntrypoint())
		return nil, fmt.Errorf("invalid MCP query format: %w", err)
	}

	if mcpQuery.MCPTool == "" {
		return nil, fmt.Errorf("MCP tool name is required")
	}

	// Call the MCP tool
	result, err := ds.MCPClient.CallTool(ctx, mcp.CallToolRequest{
		Params: mcp.CallToolParams{
			Name:      mcpQuery.MCPTool,
			Arguments: mcpQuery.MCPParameters,
		},
	})
	if err != nil {
		ctxLogger.Error("Failed to call MCP tool", "tool", mcpQuery.MCPTool, "error", err, "function", logEntrypoint())
		return nil, fmt.Errorf("failed to call MCP tool %s: %w", mcpQuery.MCPTool, err)
	}

	if result.IsError {
		return nil, fmt.Errorf("MCP tool %s returned an error: %s", mcpQuery.MCPTool, result.Content[0].(mcp.TextContent).Text) // jpe - questionable :)
	}

	queryIfExists, _ := mcpQuery.MCPParameters["query"].(string)

	dataResponse := backend.DataResponse{
		Frames: data.Frames{},
	}

	for _, c := range result.Content {
		switch content := c.(type) {
		case mcp.TextContent:
			frames, err := toolResultToDataFrame(content.Text, result.Meta["type"].(string), queryIfExists)
			if err != nil {
				ctxLogger.Error("Failed to convert tool result to data frame", "error", err, "function", logEntrypoint())
				return nil, err
			}
			dataResponse.Frames = append(dataResponse.Frames, frames...)
		default:
			ctxLogger.Warn("unexpected content type", "content", reflect.TypeOf(c), "function", logEntrypoint())
		}
	}

	return &dataResponse, nil
}

// jpe - todo: should i add a special frame meant to be fed back into the LLM? could summarize it here?
func toolResultToDataFrame(content, metaType, tempoQuery string) ([]*data.Frame, error) {
	var frames []*data.Frame

	switch metaType {
	case "":
		fallthrough
	case "text":
		fallthrough
	default:
		frames = append(frames, &data.Frame{
			RefID: "mcp_result",
			Name:  "mcp_result",
			Fields: []*data.Field{
				data.NewField("result", nil, []string{content}),
			},
		})
	case "documentation":
		frames = append(frames, &data.Frame{
			RefID: "mcp_result",
			Name:  "mcp_result",
			Fields: []*data.Field{
				data.NewField("documentation", nil, []string{content}),
			},
		})
	case "metrics-instant":
		// marshal content into a tempopb.QueryInstantResponse
		var queryInstantResponse tempopb.QueryInstantResponse
		unmarshaler := &jsonpb.Unmarshaler{}
		if err := unmarshaler.Unmarshal(strings.NewReader(content), &queryInstantResponse); err != nil {
			return nil, fmt.Errorf("failed to unmarshal metrics-instant content: %w", err)
		}

		frames = traceql.TransformInstantMetricsResponse(nil, queryInstantResponse) // jpe - unused param - remove
	case "metrics-range":
		// marshal content into a tempopb.QueryRangeResponse
		var queryRangeResponse tempopb.QueryRangeResponse
		unmarshaler := &jsonpb.Unmarshaler{}
		if err := unmarshaler.Unmarshal(strings.NewReader(content), &queryRangeResponse); err != nil {
			return nil, fmt.Errorf("failed to unmarshal metrics-range content: %w", err)
		}

		frames = traceql.TransformMetricsResponse(tempoQuery, queryRangeResponse)
	case "trace":
		// marshal content into a tempopb.Trace
		var response tempopb.TraceByIDResponse

		unmarshaler := &jsonpb.Unmarshaler{}
		if err := unmarshaler.Unmarshal(strings.NewReader(content), &response); err != nil {
			return nil, fmt.Errorf("failed to unmarshal trace content: %w", err)
		}

		frame, err := TraceToFrame(response.Trace.ResourceSpans)
		if err != nil {
			return nil, fmt.Errorf("failed to convert trace to data frame: %w", err)
		}

		frames = append(frames, frame)
	case "search-results":
		var searchResponse tempopb.SearchResponse
		unmarshaler := &jsonpb.Unmarshaler{}
		if err := unmarshaler.Unmarshal(strings.NewReader(content), &searchResponse); err != nil {
			return nil, fmt.Errorf("failed to unmarshal search-results content: %w", err)
		}

		frames = searchResultsToDataFrame(searchResponse)
	case "attribute-names":
		var searchTagValuesResponse tempopb.SearchTagsV2Response
		unmarshaler := &jsonpb.Unmarshaler{}
		if err := unmarshaler.Unmarshal(strings.NewReader(content), &searchTagValuesResponse); err != nil {
			return nil, fmt.Errorf("failed to unmarshal search-results content: %w", err)
		}

		frames = attributeNamesToDataFrame(searchTagValuesResponse)
	case "attribute-values":
		var searchTagValuesResponse tempopb.SearchTagValuesV2Response
		unmarshaler := &jsonpb.Unmarshaler{}
		if err := unmarshaler.Unmarshal(strings.NewReader(content), &searchTagValuesResponse); err != nil {
			return nil, fmt.Errorf("failed to unmarshal attribute-values content: %w", err)
		}

		frames = attributeValuesToDataFrame(searchTagValuesResponse)
	}

	return frames, nil
}

func attributeNamesToDataFrame(response tempopb.SearchTagsV2Response) []*data.Frame {
	var attributeNames []string
	var scopes []string

	for _, scope := range response.Scopes {
		for _, tagName := range scope.Tags {
			attributeNames = append(attributeNames, tagName)
			scopes = append(scopes, scope.Name)
		}
	}

	frame := &data.Frame{
		RefID: "attribute_names",
		Name:  "Attribute Names",
		Meta: &data.FrameMeta{
			PreferredVisualization: data.VisTypeTable,
		},
		Fields: []*data.Field{
			data.NewField("Scope", nil, scopes),
			data.NewField("Attribute Name", nil, attributeNames),
		},
	}

	return []*data.Frame{frame}
}

func attributeValuesToDataFrame(response tempopb.SearchTagValuesV2Response) []*data.Frame {
	var attributeValues []string
	var attributeTypes []string

	for _, tagValue := range response.TagValues {
		attributeValues = append(attributeValues, tagValue.Value)
		attributeTypes = append(attributeTypes, tagValue.Type)
	}

	frame := &data.Frame{
		RefID: "attribute_values",
		Name:  "Attribute Values",
		Meta: &data.FrameMeta{
			PreferredVisualization: data.VisTypeTable,
		},
		Fields: []*data.Field{
			data.NewField("Attribute Value", nil, attributeValues),
			data.NewField("Type", nil, attributeTypes),
		},
	}

	return []*data.Frame{frame}
}

func searchResultsToDataFrame(response tempopb.SearchResponse) []*data.Frame {
	var traceIDs []string
	var startTimes []int64
	var services []string
	var names []string
	var durations []int32

	for _, trace := range response.Traces {
		traceIDs = append(traceIDs, trace.TraceID)
		startTimes = append(startTimes, int64(trace.StartTimeUnixNano/1000000)) // Convert to milliseconds
		services = append(services, trace.RootServiceName)
		names = append(names, trace.RootTraceName)
		durations = append(durations, int32(trace.DurationMs))
	}

	frame := &data.Frame{
		RefID: "search_results",
		Name:  "Search Results",
		Meta: &data.FrameMeta{
			PreferredVisualization: data.VisTypeTable,
		},
		Fields: []*data.Field{
			data.NewField("Trace ID", nil, traceIDs),
			data.NewField("Start Time", nil, startTimes),
			data.NewField("Service", nil, services),
			data.NewField("Name", nil, names),
			data.NewField("Duration (ms)", nil, durations),
		},
	}

	return []*data.Frame{frame}
}

func (s *Service) CallResource(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error {
	switch req.Path {
	case "mcp/tools":
		return s.handleListMCPTools(ctx, req, sender)
	default:
		return sender.Send(&backend.CallResourceResponse{
			Status: http.StatusNotFound,
			Body:   []byte(`{"error": "endpoint not found"}`),
		})
	}
}

func (s *Service) handleListMCPTools(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error {
	ctxLogger := s.logger.FromContext(ctx)

	tools, err := s.ListMCPTools(ctx, req.PluginContext)
	if err != nil {
		ctxLogger.Error("Failed to list MCP tools", "error", err, "function", logEntrypoint())
		return sender.Send(&backend.CallResourceResponse{
			Status: http.StatusInternalServerError,
			Body:   []byte(fmt.Sprintf(`{"error": "%s"}`, err.Error())),
		})
	}

	response := map[string]interface{}{
		"tools": tools,
	}

	responseJSON, err := json.Marshal(response)
	if err != nil {
		ctxLogger.Error("Failed to marshal tools response", "error", err, "function", logEntrypoint())
		return sender.Send(&backend.CallResourceResponse{
			Status: http.StatusInternalServerError,
			Body:   []byte(`{"error": "failed to marshal response"}`),
		})
	}

	return sender.Send(&backend.CallResourceResponse{
		Status: http.StatusOK,
		Headers: map[string][]string{
			"Content-Type": {"application/json"},
		},
		Body: responseJSON,
	})
}
