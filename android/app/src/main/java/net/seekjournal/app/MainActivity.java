package net.seekjournal.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

/**
 * 唯一的 Activity：用系统 WebView 加载打进 APK 的前端产物。
 *
 * <p>数据流：
 * <ol>
 *   <li>页面与静态资源来自 APK 内的 {@code assets/www}，经 {@link WebViewAssetLoader}
 *       以 {@code https://appassets.androidplatform.net} 这个虚拟域名提供；</li>
 *   <li>页面里的 fetch 请求直接打到云端 HTTPS 后端（基址在打包时写进前端 bundle）；</li>
 *   <li>原生层不注入任何 JavaScript 桥，不读写业务数据，也不接触凭据。</li>
 * </ol>
 *
 * <p>安全边界：不启用 {@code file://}、不放开文件/内容访问、不忽略证书错误、禁止明文 HTTP、
 * 不使用通配域名或 {@code setAllowUniversalAccessFromFileURLs}。
 */
public class MainActivity extends Activity {

    /** WebViewAssetLoader 默认虚拟域名；用 https 提供，避免 file:// 与放宽文件访问。 */
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + ASSET_HOST + "/index.html";
    /** 前端产物在 assets 下的目录（由 scripts/build-web.ps1 写入）。 */
    private static final String ASSET_PREFIX = "/www";

    private WebView webView;
    private View errorPanel;
    private TextView errorText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.web_view);
        errorPanel = findViewById(R.id.error_panel);
        errorText = findViewById(R.id.error_text);

        Button retry = findViewById(R.id.retry_button);
        retry.setOnClickListener(v -> {
            hideError();
            webView.loadUrl(START_URL);
        });

        configureWebView();

        if (savedInstanceState != null) {
            // 旋转 / Activity 重建后恢复页面，避免正在编辑的正文被清空
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(START_URL);
        }
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();

        // 前端是 Vite + React 应用，必须执行脚本；localStorage 用于记住面板/草稿状态
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);

        // 只加载 APK 内资源：不开放 file:// 与 content:// 访问
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);

        // 按视口宽度渲染；禁用手势缩放，避免与编辑器/滚动交互冲突
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        settings.setMediaPlaybackRequiresUserGesture(true);
        // 页面本身是 https，任何 http 子资源都直接拒绝
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        webView.setWebViewClient(new AssetClient());
        // 前端使用 window.alert / window.confirm，需要系统对话框实现
        webView.setWebChromeClient(new WebChromeClient());

        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable) {
            // 仅 debug 包允许 chrome://inspect 远程调试
            WebView.setWebContentsDebuggingEnabled(true);
        }
    }

    /** 系统返回键：WebView 有历史先回退，否则交给系统（退出 / 回到桌面）。 */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) {
                parent.removeView(webView);
            }
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private void showError(String message) {
        errorText.setText(message);
        errorPanel.setVisibility(View.VISIBLE);
    }

    private void hideError() {
        errorPanel.setVisibility(View.GONE);
    }

    /** 包内请求走 WebViewAssetLoader；外部链接交给系统浏览器，不在 WebView 内导航。 */
    private final class AssetClient extends WebViewClient {

        private final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/", new WebViewAssetLoader.PathHandler() {
                    // 复用官方 AssetsPathHandler 的 MIME 推断，只把 "https 根路径" 映射到 assets/www
                    private final WebViewAssetLoader.AssetsPathHandler delegate =
                            new WebViewAssetLoader.AssetsPathHandler(MainActivity.this);

                    @Override
                    public WebResourceResponse handle(String path) {
                        String normalized = path.startsWith("/") ? path : "/" + path;
                        return delegate.handle(ASSET_PREFIX + normalized);
                    }
                })
                .build();

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return loader.shouldInterceptRequest(request.getUrl());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (uri.getHost() != null && ASSET_HOST.equals(uri.getHost())) {
                return false; // 包内页面，交给 WebView 处理
            }
            openExternally(uri);
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            // 新的一次加载开始：先收起上次的错误面板，真失败时再由 onReceivedError 重新显示
            hideError();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) {
                showError(getString(R.string.load_failed_message, String.valueOf(error.getDescription())));
            }
        }
    }

    private void openExternally(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        boolean supported = "http".equals(scheme)
                || "https".equals(scheme)
                || "mailto".equals(scheme)
                || "tel".equals(scheme);
        if (!supported) {
            Toast.makeText(this, R.string.unsupported_link, Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show();
        }
    }
}
