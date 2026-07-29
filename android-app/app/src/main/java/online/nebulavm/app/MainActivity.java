package online.nebulavm.app;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public final class MainActivity extends Activity {
    private static final String REGISTRY_URL =
            "https://nebulavm.online/.netlify/functions/host-registry";
    private static final int CYAN = Color.rgb(67, 216, 255);
    private static final int GREEN = Color.rgb(167, 237, 67);
    private static final int YELLOW = Color.rgb(255, 227, 79);
    private static final int TEXT = Color.rgb(244, 248, 252);
    private static final int MUTED = Color.rgb(155, 175, 193);

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newFixedThreadPool(2);
    private final AtomicBoolean frameInFlight = new AtomicBoolean(false);
    private final String sessionId = UUID.randomUUID().toString().replace("-", "");
    private final List<Integer> versions = new ArrayList<>();

    private Spinner versionSpinner;
    private Button startButton;
    private Button stopButton;
    private TextView statusText;
    private TextView hostMemoryText;
    private ProgressBar progress;
    private ConsoleView console;

    private volatile String hostBase;
    private volatile String hostToken;
    private volatile boolean running;
    private volatile boolean foreground;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(7, 16, 25));
        getWindow().setNavigationBarColor(Color.rgb(7, 16, 25));
        setContentView(buildInterface());
        discoverHost();
    }

    private View buildInterface() {
        LinearLayout root = column();
        root.setPadding(dp(14), dp(12), dp(14), dp(12));
        root.setBackgroundColor(Color.rgb(7, 16, 25));

        LinearLayout header = row();
        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.nebulavm_logo);
        logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
        header.addView(logo, new LinearLayout.LayoutParams(dp(44), dp(44)));

        LinearLayout titleBox = column();
        titleBox.setPadding(dp(9), 0, 0, 0);
        TextView kicker = text("NATIVE ANDROID CLIENT", 10, GREEN, true);
        TextView title = text("NebulaVM", 24, TEXT, true);
        titleBox.addView(kicker);
        titleBox.addView(title);
        header.addView(titleBox, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        root.addView(header);

        TextView warning = text(
                "EXPERIMENTAL  /  Android only  /  20-minute private sessions",
                11, Color.rgb(16, 18, 20), true);
        warning.setGravity(Gravity.CENTER);
        warning.setPadding(dp(8), dp(7), dp(8), dp(7));
        warning.setBackgroundColor(Color.rgb(255, 89, 89));
        LinearLayout.LayoutParams warningParams =
                new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        warningParams.setMargins(0, dp(8), 0, dp(8));
        root.addView(warning, warningParams);

        LinearLayout statusRow = row();
        statusText = text("Finding your NebulaVM host...", 13, TEXT, true);
        statusText.setBackgroundResource(R.drawable.panel);
        statusText.setPadding(dp(10), dp(8), dp(10), dp(8));
        statusRow.addView(statusText, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        progress = new ProgressBar(this);
        progress.setIndeterminate(true);
        LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(dp(38), dp(38));
        progressParams.setMargins(dp(8), 0, 0, 0);
        statusRow.addView(progress, progressParams);
        root.addView(statusRow);

        hostMemoryText = text("Host memory unavailable", 12, MUTED, false);
        hostMemoryText.setPadding(0, dp(6), 0, dp(6));
        root.addView(hostMemoryText);

        TextView versionLabel = text("Android version", 11, MUTED, true);
        versionLabel.setPadding(0, dp(2), 0, dp(4));
        root.addView(versionLabel);

        versionSpinner = new Spinner(this);
        versionSpinner.setBackgroundResource(R.drawable.panel);
        versionSpinner.setPadding(dp(10), 0, dp(10), 0);
        versionSpinner.setEnabled(false);
        root.addView(versionSpinner, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));

        LinearLayout controls = row();
        startButton = button("Start Android", true);
        startButton.setEnabled(false);
        startButton.setOnClickListener(v -> startAndroid());
        LinearLayout.LayoutParams startParams = new LinearLayout.LayoutParams(0, dp(48), 2);
        startParams.setMargins(0, 0, dp(4), 0);
        controls.addView(startButton, startParams);

        stopButton = button("Stop", false);
        stopButton.setEnabled(false);
        stopButton.setOnClickListener(v -> stopAndroid(true));
        LinearLayout.LayoutParams stopParams = new LinearLayout.LayoutParams(0, dp(48), 1);
        stopParams.setMargins(dp(4), 0, 0, 0);
        controls.addView(stopButton, stopParams);
        LinearLayout.LayoutParams controlsParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        controlsParams.setMargins(0, dp(8), 0, 0);
        root.addView(controls, controlsParams);

        console = new ConsoleView();
        console.setScaleType(ImageView.ScaleType.FIT_CENTER);
        console.setBackgroundColor(Color.BLACK);
        console.setImageResource(R.drawable.nebulavm_logo);
        console.setPadding(dp(42), dp(42), dp(42), dp(42));
        LinearLayout.LayoutParams consoleParams =
                new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1);
        consoleParams.setMargins(0, dp(10), 0, dp(8));
        root.addView(console, consoleParams);

        LinearLayout nav = row();
        nav.setGravity(Gravity.CENTER);
        Button back = navButton("\u25C0");
        Button home = navButton("\u25CF");
        Button recents = navButton("\u25A0");
        back.setOnClickListener(v -> sendInput("{\"type\":\"key\",\"key\":\"back\"}"));
        home.setOnClickListener(v -> sendInput("{\"type\":\"key\",\"key\":\"home\"}"));
        recents.setOnClickListener(v -> sendInput("{\"type\":\"key\",\"key\":\"recents\"}"));
        nav.addView(back);
        nav.addView(home);
        nav.addView(recents);
        root.addView(nav);

        TextView limits = text(
                "Adaptive RAM  /  up to 2 cores  /  4 GB storage  /  portrait",
                11, MUTED, false);
        limits.setGravity(Gravity.CENTER);
        limits.setPadding(0, dp(7), 0, 0);
        root.addView(limits);
        return root;
    }

    private void discoverHost() {
        setBusy("Finding your NebulaVM host...");
        network.execute(() -> {
            try {
                HttpResult registry = request("GET", REGISTRY_URL, null, false);
                JSONObject root = new JSONObject(registry.text());
                JSONObject host = root.getJSONObject("host");
                hostBase = host.getString("publicUrl").replaceAll("/+$", "");
                hostToken = host.getString("accessToken");
                loadStatus();
            } catch (Exception error) {
                showError("Host offline. Keep NebulaVM Host running on the Windows computer.");
            }
        });
    }

    private void loadStatus() {
        try {
            HttpResult result = request("GET", hostBase + "/api/android-emulator/status", null, true);
            JSONObject data = new JSONObject(result.text());
            updateMemory(data.optJSONObject("hostMemory"));
            JSONArray catalog = data.optJSONArray("versions");
            versions.clear();
            List<String> labels = new ArrayList<>();
            if (catalog != null) {
                for (int i = 0; i < catalog.length(); i++) {
                    JSONObject item = catalog.getJSONObject(i);
                    if (item.optBoolean("available")) {
                        int version = item.optInt("version");
                        versions.add(version);
                        labels.add("Android " + version);
                    }
                }
            }
            main.post(() -> {
                ArrayAdapter<String> adapter = new ArrayAdapter<String>(
                        this, android.R.layout.simple_spinner_dropdown_item, labels) {
                    @Override
                    public View getView(int position, View convertView, ViewGroup parent) {
                        TextView view = (TextView) super.getView(position, convertView, parent);
                        styleSpinnerText(view, TEXT);
                        return view;
                    }

                    @Override
                    public View getDropDownView(int position, View convertView, ViewGroup parent) {
                        TextView view = (TextView) super.getDropDownView(position, convertView, parent);
                        styleSpinnerText(view, Color.rgb(16, 24, 32));
                        return view;
                    }
                };
                versionSpinner.setAdapter(adapter);
                versionSpinner.setEnabled(!labels.isEmpty());
                startButton.setEnabled(!labels.isEmpty());
                progress.setVisibility(View.GONE);
                statusText.setText(labels.isEmpty()
                        ? "No Android system images are installed on the host"
                        : "Host ready - choose a real Android version");
            });
        } catch (Exception error) {
            showError("Android host unavailable. Check the Windows host and try again.");
        }
    }

    private void startAndroid() {
        if (versions.isEmpty() || versionSpinner.getSelectedItemPosition() < 0) return;
        int version = versions.get(versionSpinner.getSelectedItemPosition());
        setBusy("Starting Android " + version + "...");
        startButton.setEnabled(false);
        versionSpinner.setEnabled(false);
        network.execute(() -> {
            try {
                String body = "{\"version\":" + version
                        + ",\"cores\":2,\"memoryMb\":0,\"storageGb\":4,\"orientation\":\"portrait\"}";
                HttpResult result = request(
                        "POST", hostBase + "/api/android-emulator/start", body, true);
                JSONObject data = new JSONObject(result.text());
                if (!data.optBoolean("ok", false)) {
                    throw new IllegalStateException(data.optString("error", "Android could not start."));
                }
                running = true;
                updateMemory(data.optJSONObject("hostMemory"));
                main.post(() -> {
                    progress.setVisibility(View.GONE);
                    stopButton.setEnabled(true);
                    statusText.setText("Android " + version + " is cold booting");
                    console.setPadding(0, 0, 0, 0);
                    scheduleFrame(250);
                });
            } catch (Exception error) {
                running = false;
                showError(messageOf(error));
                main.post(() -> {
                    startButton.setEnabled(true);
                    versionSpinner.setEnabled(true);
                });
            }
        });
    }

    private void scheduleFrame(long delayMs) {
        main.postDelayed(() -> {
            if (!running || !foreground || !frameInFlight.compareAndSet(false, true)) return;
            network.execute(() -> {
                try {
                    HttpResult frame = request(
                            "GET", hostBase + "/api/android-emulator/frame?t=" + System.currentTimeMillis(),
                            null, true);
                    Bitmap bitmap = BitmapFactory.decodeByteArray(frame.body, 0, frame.body.length);
                    if (bitmap == null) throw new IllegalStateException("The host returned an empty frame.");
                    main.post(() -> {
                        console.setFrame(bitmap);
                        statusText.setText("Android running - private host session");
                    });
                } catch (Exception ignored) {
                    main.post(() -> statusText.setText("Android is still starting..."));
                } finally {
                    frameInFlight.set(false);
                    if (running && foreground) scheduleFrame(1100);
                }
            });
        }, delayMs);
    }

    private void stopAndroid(boolean showReady) {
        if (!running) return;
        running = false;
        frameInFlight.set(false);
        main.removeCallbacksAndMessages(null);
        setBusy("Ending private Android session...");
        network.execute(() -> {
            try {
                request("POST", hostBase + "/api/android-emulator/stop", "{}", true);
            } catch (Exception ignored) {
            }
            main.post(() -> {
                console.clearFrame();
                progress.setVisibility(View.GONE);
                stopButton.setEnabled(false);
                startButton.setEnabled(true);
                versionSpinner.setEnabled(true);
                if (showReady) statusText.setText("Session ended - host ready");
            });
        });
    }

    private void sendInput(String body) {
        if (!running) return;
        network.execute(() -> {
            try {
                request("POST", hostBase + "/api/android-emulator/input", body, true);
            } catch (Exception error) {
                main.post(() -> Toast.makeText(
                        this, "Android is still starting.", Toast.LENGTH_SHORT).show());
            }
        });
    }

    private HttpResult request(String method, String address, String body, boolean authenticated)
            throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(12000);
        connection.setReadTimeout(address.contains("/frame") ? 20000 : 30000);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", address.contains("/frame") ? "image/png" : "application/json");
        if (authenticated) {
            connection.setRequestProperty("Authorization", "Bearer " + hostToken);
            connection.setRequestProperty("X-NebulaVM-Session", sessionId);
            connection.setRequestProperty("X-NebulaVM-Client-Class", "public-mobile");
        }
        if (body != null) {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
        }
        int status = connection.getResponseCode();
        InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        byte[] response = readAll(input);
        connection.disconnect();
        if (status >= 400) {
            String message = new String(response, StandardCharsets.UTF_8);
            try {
                message = new JSONObject(message).optString("error", message);
            } catch (Exception ignored) {
            }
            throw new IllegalStateException(message);
        }
        return new HttpResult(response);
    }

    private static byte[] readAll(InputStream input) throws Exception {
        if (input == null) return new byte[0];
        try (InputStream source = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int count;
            while ((count = source.read(buffer)) >= 0) output.write(buffer, 0, count);
            return output.toByteArray();
        }
    }

    private void updateMemory(JSONObject memory) {
        if (memory == null) return;
        double available = memory.optDouble("availableBytes", 0) / 1073741824d;
        double total = memory.optDouble("totalBytes", 0) / 1073741824d;
        main.post(() -> hostMemoryText.setText(String.format(
                java.util.Locale.US, "%.1f GB/%.0f GB available on host", available, total)));
    }

    private void setBusy(String message) {
        main.post(() -> {
            statusText.setText(message);
            progress.setVisibility(View.VISIBLE);
        });
    }

    private void showError(String message) {
        main.post(() -> {
            progress.setVisibility(View.GONE);
            statusText.setText(message);
            Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        });
    }

    private String messageOf(Exception error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty()
                ? "The Android session could not be started."
                : message;
    }

    @Override
    protected void onResume() {
        super.onResume();
        foreground = true;
        if (running) scheduleFrame(0);
    }

    @Override
    protected void onPause() {
        foreground = false;
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (isFinishing() && running) stopAndroid(false);
        network.shutdown();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (running) sendInput("{\"type\":\"key\",\"key\":\"back\"}");
        else super.onBackPressed();
    }

    private LinearLayout column() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.VERTICAL);
        return view;
    }

    private LinearLayout row() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.HORIZONTAL);
        view.setGravity(Gravity.CENTER_VERTICAL);
        return view;
    }

    private TextView text(String value, int sp, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        if (bold) view.setTypeface(view.getTypeface(), android.graphics.Typeface.BOLD);
        return view;
    }

    private Button button(String label, boolean primary) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(label);
        button.setTextSize(12);
        button.setTextColor(primary ? Color.rgb(16, 18, 20) : TEXT);
        button.setBackgroundResource(primary ? R.drawable.button_primary : R.drawable.button_secondary);
        button.setPadding(dp(5), 0, dp(5), 0);
        return button;
    }

    private Button navButton(String label) {
        Button button = button(label, false);
        button.setTextSize(18);
        button.setContentDescription(
                "\u25C0".equals(label) ? "Back" : "\u25CF".equals(label) ? "Home" : "Recent apps");
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(48), 1);
        params.setMargins(dp(4), 0, dp(4), 0);
        button.setLayoutParams(params);
        return button;
    }

    private void styleSpinnerText(TextView view, int color) {
        view.setTextColor(color);
        view.setTextSize(15);
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setPadding(dp(12), 0, dp(12), 0);
        view.setSingleLine(true);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private final class ConsoleView extends ImageView {
        private Bitmap current;
        private float downX;
        private float downY;
        private long downAt;

        ConsoleView() {
            super(MainActivity.this);
            setOnTouchListener((view, event) -> {
                if (!running || current == null) return true;
                if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
                    downX = event.getX();
                    downY = event.getY();
                    downAt = System.currentTimeMillis();
                    return true;
                }
                if (event.getActionMasked() == MotionEvent.ACTION_UP) {
                    float[] start = frameCoordinate(downX, downY);
                    float[] end = frameCoordinate(event.getX(), event.getY());
                    double distance = Math.hypot(end[0] - start[0], end[1] - start[1]);
                    if (distance < 18) {
                        sendInput("{\"type\":\"tap\",\"x\":" + Math.round(end[0])
                                + ",\"y\":" + Math.round(end[1]) + "}");
                    } else {
                        long duration = Math.max(50, Math.min(3000, System.currentTimeMillis() - downAt));
                        sendInput("{\"type\":\"swipe\",\"x1\":" + Math.round(start[0])
                                + ",\"y1\":" + Math.round(start[1])
                                + ",\"x2\":" + Math.round(end[0])
                                + ",\"y2\":" + Math.round(end[1])
                                + ",\"duration\":" + duration + "}");
                    }
                    performClick();
                    return true;
                }
                return true;
            });
        }

        void setFrame(Bitmap bitmap) {
            Bitmap previous = current;
            current = bitmap;
            setImageBitmap(bitmap);
            if (previous != null && previous != bitmap && !previous.isRecycled()) previous.recycle();
        }

        void clearFrame() {
            Bitmap previous = current;
            current = null;
            setImageResource(R.drawable.nebulavm_logo);
            setPadding(dp(42), dp(42), dp(42), dp(42));
            if (previous != null && !previous.isRecycled()) previous.recycle();
        }

        private float[] frameCoordinate(float x, float y) {
            float scale = Math.min(
                    getWidth() / (float) current.getWidth(),
                    getHeight() / (float) current.getHeight());
            float renderedWidth = current.getWidth() * scale;
            float renderedHeight = current.getHeight() * scale;
            float left = (getWidth() - renderedWidth) / 2f;
            float top = (getHeight() - renderedHeight) / 2f;
            float frameX = Math.max(0, Math.min(current.getWidth(), (x - left) / scale));
            float frameY = Math.max(0, Math.min(current.getHeight(), (y - top) / scale));
            return new float[]{frameX, frameY};
        }
    }

    private static final class HttpResult {
        final byte[] body;

        HttpResult(byte[] body) {
            this.body = body;
        }

        String text() {
            return new String(body, StandardCharsets.UTF_8);
        }
    }
}
