import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/dashboard_url_web.dart';
import 'package:rusa_dashboard/widgets/header.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'writes dashboard URLs through Flutter navigation with replacement',
    () async {
      final calls = <MethodCall>[];
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(SystemChannels.navigation, (
        call,
      ) async {
        calls.add(call);
        return null;
      });
      addTearDown(
        () =>
            messenger.setMockMethodCallHandler(SystemChannels.navigation, null),
      );

      writeDashboardViewToUrl(DashboardView.actors, focusedActorId: 'a1');
      await Future<void>.delayed(Duration.zero);

      expect(calls, hasLength(1));
      expect(calls.single.method, 'routeInformationUpdated');
      expect(calls.single.arguments, <String, Object?>{
        'uri': '/actors/a1',
        'state': null,
        'replace': true,
      });
    },
  );
}
