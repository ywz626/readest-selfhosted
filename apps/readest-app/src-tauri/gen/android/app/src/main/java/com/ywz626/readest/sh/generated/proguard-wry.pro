# THIS FILE IS AUTO-GENERATED. DO NOT MODIFY!!

# Copyright 2020-2023 Tauri Programme within The Commons Conservancy
# SPDX-License-Identifier: Apache-2.0
# SPDX-License-Identifier: MIT

-keep class com.ywz626.readest.sh.* {
  native <methods>;
}

-keep class com.ywz626.readest.sh.WryActivity {
  public <init>(...);

  void setWebView(com.ywz626.readest.sh.RustWebView);
  java.lang.Class getAppClass(...);
  int getId();
  java.lang.String getVersion();
  int startActivity(...);
}

-keep class com.ywz626.readest.sh.Ipc {
  public <init>(...);

  @android.webkit.JavascriptInterface public <methods>;
}

-keep class com.ywz626.readest.sh.RustWebView {
  public <init>(...);

  void loadUrlMainThread(...);
  void loadHTMLMainThread(...);
  void evalScript(...);
}

-keep class com.ywz626.readest.sh.RustWebChromeClient,com.ywz626.readest.sh.RustWebViewClient {
  public <init>(...);
}
