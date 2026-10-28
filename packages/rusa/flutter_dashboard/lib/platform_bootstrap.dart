export 'platform_bootstrap_stub.dart'
    if (dart.library.html) 'platform_bootstrap_web.dart'
    if (dart.library.io) 'platform_bootstrap_io.dart';
