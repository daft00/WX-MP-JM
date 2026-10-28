import { ServiceContainer } from "./contracts";
import { getApiConfig } from "./api-config";
import { createHttpServices } from "./http-services";

export const apiConfig = getApiConfig();
export const services: ServiceContainer = createHttpServices(apiConfig.baseUrl);
