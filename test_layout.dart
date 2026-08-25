import 'package:flutter/widgets.dart';

void main() {
  runApp(
    Directionality(
      textDirection: TextDirection.ltr,
      child: Padding(
        padding: const EdgeInsets.all(48.0),
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.max,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Flexible(
                child: SizedBox(width: 4000, height: 4000), // Huge image
              ),
              const SizedBox(height: 16),
              SizedBox(width: 100, height: 40), // Buttons
            ],
          ),
        ),
      ),
    ),
  );
}
