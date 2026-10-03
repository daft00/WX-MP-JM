import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    let message: string | string[] = status === 503 ? "Service unavailable" : "Internal server error";

    if (exception instanceof HttpException && status < 500) {
      const body = exception.getResponse();
      if (typeof body === "string") {
        message = body;
      } else if ("message" in body) {
        const detail = body.message;
        if (typeof detail === "string" ||
            (Array.isArray(detail) && detail.every((item) => typeof item === "string"))) {
          message = detail;
        }
      }
    }
    if (status >= 500) {
      // 不记录原始异常、SQL、请求参数或连接串，避免泄漏凭据和家庭数据。
      this.logger.error(`Request failed with status ${status}`);
    }
    if (status === 401) response.setHeader("WWW-Authenticate", "Bearer");
    response.status(status).json({
      statusCode: status,
      code: HttpStatus[status] ?? "HTTP_ERROR",
      message,
      path: request.path,
      timestamp: new Date().toISOString(),
    });
  }
}
