import toast from "react-hot-toast";
import { WS_BACKEND_URL } from "./config";
import {
  APP_ERROR_WEB_SOCKET_CODE,
  USER_CLOSE_WEB_SOCKET_CODE,
} from "./constants";
import { FullGenerationSettings } from "./types";

const ERROR_MESSAGE =
  "Error generating code. Check the Developer Console AND the backend logs for details. Feel free to open a Github issue.";

const CANCEL_MESSAGE = "Code generation cancelled";

type WebSocketResponse = {
  type:
    | "chunk"
    | "status"
    | "setCode"
    | "error"
    | "variantComplete"
    | "variantError"
    | "variantCount"
    | "variantModels"
    | "thinking"
    | "assistant"
    | "toolStart"
    | "toolResult";
  value?: string;
  data?: any;
  eventId?: string;
  variantIndex: number;
};

interface CodeGenerationCallbacks {
  onChange: (chunk: string, variantIndex: number) => void;
  onSetCode: (code: string, variantIndex: number) => void;
  onStatusUpdate: (status: string, variantIndex: number) => void;
  onVariantComplete: (variantIndex: number) => void;
  onVariantError: (variantIndex: number, error: string) => void;
  onVariantCount: (count: number) => void;
  onVariantModels: (models: string[]) => void;
  onThinking: (content: string, variantIndex: number, eventId?: string) => void;
  onAssistant: (content: string, variantIndex: number, eventId?: string) => void;
  onToolStart: (data: any, variantIndex: number, eventId?: string) => void;
  onToolResult: (data: any, variantIndex: number, eventId?: string) => void;
  onCancel: (
    reason: "user_cancelled" | "request_failed" | "connection_error",
    errorMessage?: string
  ) => void;
  onComplete: () => void;
  // Called when user explicitly cancelled (close code 4333). Defaults to
  // showing a "cancelled" toast; pass false to suppress for programmatic cancels.
  showCancelToast?: boolean;
}

export function generateCode(
  wsRef: React.MutableRefObject<WebSocket | null>,
  params: FullGenerationSettings,
  callbacks: CodeGenerationCallbacks
) {
  const wsUrl = `${WS_BACKEND_URL}/generate-code`;
  console.log("Connecting to backend @ ", wsUrl);

  // Close any prior socket before opening a new one. Without this, a doUpdate
  // call while a prior generation is still live would orphan the old socket,
  // leaving it open and consuming a server slot against MAX_CONCURRENT_SOCKETS.
  if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
    wsRef.current.close(USER_CLOSE_WEB_SOCKET_CODE);
  }

  const ws = new WebSocket(wsUrl);
  wsRef.current = ws;

  // Guard: the "error" event always fires before "close" on a failed connection,
  // so track whether we already showed an error toast to avoid doubling up.
  let errorToastShown = false;

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify(params));
  });

  ws.addEventListener("message", async (event: MessageEvent) => {
    let response: WebSocketResponse;
    try {
      response = JSON.parse(event.data) as WebSocketResponse;
    } catch {
      console.warn("Received non-JSON WebSocket frame — ignoring", event.data);
      return;
    }
    if (response.type === "chunk") {
      callbacks.onChange(response.value || "", response.variantIndex);
    } else if (response.type === "status") {
      callbacks.onStatusUpdate(response.value || "", response.variantIndex);
    } else if (response.type === "setCode") {
      callbacks.onSetCode(response.value || "", response.variantIndex);
    } else if (response.type === "variantComplete") {
      callbacks.onVariantComplete(response.variantIndex);
    } else if (response.type === "variantError") {
      callbacks.onVariantError(response.variantIndex, response.value || "");
    } else if (response.type === "variantCount") {
      callbacks.onVariantCount(parseInt(response.value || "1"));
    } else if (response.type === "variantModels") {
      callbacks.onVariantModels(response.data?.models || []);
    } else if (response.type === "thinking") {
      callbacks.onThinking(response.value || "", response.variantIndex, response.eventId);
    } else if (response.type === "assistant") {
      callbacks.onAssistant(response.value || "", response.variantIndex, response.eventId);
    } else if (response.type === "toolStart") {
      callbacks.onToolStart(response.data, response.variantIndex, response.eventId);
    } else if (response.type === "toolResult") {
      callbacks.onToolResult(response.data, response.variantIndex, response.eventId);
    } else if (response.type === "error") {
      console.error("Error generating code", response.value);
      errorToastShown = true; // prevent the close handler from double-toasting
      toast.error(response.value || ERROR_MESSAGE);
    }
  });

  ws.addEventListener("close", (event) => {
    console.log("Connection closed", event.code, event.reason);
    if (event.code === USER_CLOSE_WEB_SOCKET_CODE) {
      if (callbacks.showCancelToast !== false) toast.success(CANCEL_MESSAGE);
      callbacks.onCancel("user_cancelled");
    } else if (event.code === APP_ERROR_WEB_SOCKET_CODE) {
      console.error("Known server error", event);
      // Show a toast so the user knows the generation failed (the close reason
      // carries the short error text; fall back to the generic message).
      if (!errorToastShown) {
        errorToastShown = true;
        toast.error(event.reason || ERROR_MESSAGE);
      }
      callbacks.onCancel("request_failed", event.reason || ERROR_MESSAGE);
    } else if (event.code !== 1000) {
      console.error("Unknown server or connection error", event);
      if (!errorToastShown) {
        errorToastShown = true;
        toast.error(ERROR_MESSAGE);
      }
      callbacks.onCancel("connection_error", event.reason || ERROR_MESSAGE);
    } else {
      // If the server sent a type:'error' message before closing cleanly (code 1000),
      // the generation failed despite the clean close code. Treat as a request failure
      // rather than a success so we don't transition to CODE_READY with a broken state.
      if (errorToastShown) {
        callbacks.onCancel("request_failed");
      } else {
        callbacks.onComplete();
      }
    }
  });

  ws.addEventListener("error", (error) => {
    console.error("WebSocket error", error);
    if (!errorToastShown) {
      errorToastShown = true;
      toast.error(ERROR_MESSAGE);
    }
  });
}
