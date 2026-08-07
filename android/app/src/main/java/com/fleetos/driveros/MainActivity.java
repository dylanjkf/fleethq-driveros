package com.fleetos.driveros;

import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Security audit (Low): FLAG_SECURE keeps delivery photos, capture
        // signatures and customer addresses out of OS screenshots and the
        // Recents/app-switcher thumbnail, and blocks screen recording/casting
        // of that content on this shared field device.
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        );
    }
}
