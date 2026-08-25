import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';

import 'fakes.dart';

String legacyConversationSender(MeshEvent event, Set<String> selection) =>
    event.messageRecipient ??
    selection.firstWhere((id) => id != event.actorId, orElse: () => '');

String legacyOperatorSender(MeshEvent event, String selectedId) =>
    event.messageRecipient ??
    (event.actorId == 'human:operator' ? selectedId : 'human:operator');

void main() {
  test('messageSender resolves payload-backed and legacy message rows', () {
    final actorToPeer = makeEvent(
      'a-to-b',
      'message_sent',
      actor: 'actor-a',
      payload: '{"messageId":"m1","to":"actor-b"}',
    );
    final actorReplyToOperator = makeEvent(
      'actor-reply',
      'message_sent',
      actor: 'actor-a',
      payload: '{"messageId":"m2","to":"human:operator"}',
    );
    final receivedFromPeer = makeEvent(
      'b-received',
      'message_received',
      actor: 'actor-b',
      payload: '{"messageId":"m3","from":"actor-a"}',
    );
    final legacyPeerRow = makeEvent(
      'legacy',
      'message_sent',
      actor: 'actor-b',
      payload: '{"from":"actor-a"}',
    );

    expect(actorToPeer.messageSender, 'actor-a');
    expect(actorToPeer.messageRecipient, 'actor-b');
    expect(actorReplyToOperator.messageSender, 'actor-a');
    expect(actorReplyToOperator.messageRecipient, 'human:operator');
    expect(receivedFromPeer.messageSender, 'actor-a');
    expect(receivedFromPeer.messageRecipient, 'actor-b');
    expect(legacyPeerRow.messageSender, 'actor-a');
    expect(legacyPeerRow.messageRecipient, 'actor-b');

    expect(
      legacyConversationSender(actorToPeer, {'actor-a', 'actor-b'}),
      'actor-b',
    );
    expect(
      legacyOperatorSender(actorReplyToOperator, 'actor-a'),
      'human:operator',
    );
  });
}
