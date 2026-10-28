export const API_BASE_URL = "https://api.daftjiang.cn/api/v1";

export function getApiConfig(): { baseUrl: string; development: boolean } {
  const development = wx.getAccountInfoSync().miniProgram.envVersion === "develop"
    && wx.getDeviceInfo().platform === "devtools";
  const override: unknown = development ? wx.getStorageSync("growth_diary_dev_api_url") : "";
  if (!override) return { baseUrl: API_BASE_URL, development: false };
  // 隧道地址仅由开发者工具的本机存储提供，不打包任何本机 API 地址。
  if (typeof override !== "string" || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/api\/v1$/.test(override)) {
    throw new Error("开发 API 地址必须是本机 SSH 隧道的 /api/v1 地址");
  }
  return { baseUrl: override, development: true };
}
