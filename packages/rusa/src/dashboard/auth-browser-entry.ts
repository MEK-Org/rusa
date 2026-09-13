import { showAuthStartupError, startDashboardAuth } from "./auth-browser.js";

void startDashboardAuth().catch(showAuthStartupError);
