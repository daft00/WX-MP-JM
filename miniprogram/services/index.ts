import { ServiceContainer } from "./contracts";
import { mockServices } from "./mock-services";

// 腾讯云和后端准备完成后，只需在此处替换为 HttpServiceContainer。
export const services: ServiceContainer = mockServices;
